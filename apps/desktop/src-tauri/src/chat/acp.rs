use super::codex::{Rpc, ANSWER_LIMIT, TURN_TIMEOUT};
use super::{ChatDelta, Choice, Model, ModelCatalog, ModelOptions, Platform, Turn};
use serde_json::{json, Value};
use std::{
    env,
    ffi::{OsStr, OsString},
    path::PathBuf,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};
use tauri::Emitter;

pub(super) struct Session {
    rpc: Rpc,
    id: String,
    catalog: Vec<Model>,
    model_config: Option<String>,
    default_model: Option<String>,
    current_model: Option<String>,
    thinking: Option<ThinkingConfig>,
}

fn executable(platform: Platform) -> Result<PathBuf, String> {
    let name = if platform == Platform::GrokBuild {
        "grok.exe"
    } else {
        "opencode.exe"
    };
    let mut candidates = Vec::new();
    if platform == Platform::GrokBuild {
        candidates.extend(env::var_os("LAB_M4_GROK_EXE").map(PathBuf::from));
        if let Some(home) = env::var_os("GROK_HOME")
            .map(PathBuf::from)
            .or_else(|| crate::user_home().ok().map(|path| path.join(".grok")))
        {
            candidates.push(home.join("bin").join(name));
        }
    } else {
        candidates.extend(env::var_os("LAB_M4_OPENCODE_EXE").map(PathBuf::from));
        if let Some(appdata) = env::var_os("APPDATA") {
            let base = PathBuf::from(appdata).join("npm/node_modules/opencode-ai");
            let architecture = if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            };
            candidates.push(base.join(format!(
                "node_modules/opencode-windows-{architecture}/bin/{name}"
            )));
            candidates.push(base.join("bin").join(name));
        }
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(
            env::split_paths(&path)
                .filter(|dir| dir.is_absolute())
                .map(|dir| dir.join(name)),
        );
    }
    candidates
        .into_iter()
        .find(|path| {
            path.is_absolute()
                && path.is_file()
                && path
                    .file_name()
                    .is_some_and(|file| file.eq_ignore_ascii_case(name))
        })
        .ok_or_else(|| {
            format!(
                "Nenašiel som {} CLI. Nainštaluj ho a prihlás sa.",
                platform.label()
            )
        })
}

fn model_option(result: &Value) -> Option<&Value> {
    result["configOptions"]
        .as_array()?
        .iter()
        .find(|item| item["category"] == "model" || item["id"] == "model")
}

fn catalog(result: &Value) -> (Option<String>, Option<String>, Vec<Model>) {
    if let Some(option) = model_option(result) {
        let mut models = Vec::new();
        for item in option["options"].as_array().into_iter().flatten() {
            let values = item["options"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(std::slice::from_ref(item));
            models.extend(values.iter().filter_map(|model| {
                let id = model["value"].as_str()?;
                Some(Model {
                    id: id.into(),
                    name: model["name"].as_str().unwrap_or(id).into(),
                    options: ModelOptions::default(),
                    default_thinking: None,
                })
            }));
        }
        return (
            option["id"].as_str().map(str::to_owned),
            option["currentValue"].as_str().map(str::to_owned),
            models,
        );
    }
    let models = &result["models"];
    (
        None,
        models["currentModelId"].as_str().map(str::to_owned),
        models["availableModels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model["modelId"].as_str()?;
                Some(Model {
                    id: id.into(),
                    name: model["name"].as_str().unwrap_or(id).into(),
                    options: ModelOptions::default(),
                    default_thinking: None,
                })
            })
            .collect(),
    )
}

struct ThinkingConfig {
    id: String,
    initial: String,
    current: String,
    choices: Vec<Choice>,
}

impl ThinkingConfig {
    fn from_config(result: &Value) -> Option<Self> {
        let option = result["configOptions"].as_array()?.iter().find(|option| {
            option["type"] == "select"
                && (option["category"] == "thought_level"
                    || matches!(option["id"].as_str(), Some("effort" | "reasoning_effort")))
        })?;
        let choices: Vec<_> = option["options"]
            .as_array()?
            .iter()
            .flat_map(|entry| {
                entry["options"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(std::slice::from_ref(entry))
            })
            .filter_map(|entry| {
                let id = entry["value"].as_str()?;
                Some(Choice {
                    id: id.into(),
                    name: entry["name"].as_str().unwrap_or(id).into(),
                    description: entry["description"].as_str().map(str::to_owned),
                })
            })
            .collect();
        let current = option["currentValue"].as_str()?.to_owned();
        Some(Self {
            id: option["id"].as_str()?.into(),
            initial: current.clone(),
            current,
            choices,
        })
    }
}

impl Session {
    pub(super) fn start(platform: Platform, cancel: &AtomicBool) -> Result<Self, String> {
        let exe = executable(platform)?;
        let grok = platform == Platform::GrokBuild;
        let cwd = crate::user_home()?
            .join(".lab-m4")
            .join("chat")
            .join(if grok { "grok" } else { "opencode" });
        std::fs::create_dir_all(&cwd).map_err(|_| "Chat nemá pracovný priečinok.")?;
        let system =
            PathBuf::from(env::var_os("SystemRoot").ok_or("Chýba systémový priečinok Windows.")?);
        let path = env::join_paths([
            exe.parent().ok_or("Neplatná cesta k CLI.")?,
            &system.join("System32"),
        ])
        .map_err(|_| "Neplatná cesta k CLI.")?;
        let common = [
            "SystemRoot",
            "WINDIR",
            "USERPROFILE",
            "HOME",
            "APPDATA",
            "LOCALAPPDATA",
            "TMP",
            "TEMP",
        ];
        let credentials: &[&str] = if grok {
            &["GROK_HOME", "XAI_API_KEY"]
        } else {
            &[
                "XDG_DATA_HOME",
                "XDG_CACHE_HOME",
                "XDG_STATE_HOME",
                "OPENCODE_DB",
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "OPENROUTER_API_KEY",
                "GOOGLE_GENERATIVE_AI_API_KEY",
                "GEMINI_API_KEY",
                "XAI_API_KEY",
                "OPENCODE_API_KEY",
            ]
        };
        let mut environment: Vec<(&str, OsString)> = common
            .iter()
            .chain(credentials)
            .filter_map(|name| env::var_os(name).map(|value| (*name, value)))
            .collect();
        environment.push(("PATH", path));
        if !grok {
            let config = cwd.join("config");
            std::fs::create_dir_all(&config).map_err(|_| "OpenCode nemá pracovný priečinok.")?;
            environment.extend([
                ("XDG_CONFIG_HOME", config.clone().into_os_string()),
                ("OPENCODE_CONFIG_DIR", config.into_os_string()),
                ("OPENCODE_DISABLE_PROJECT_CONFIG", "1".into()),
                ("OPENCODE_DISABLE_AUTOUPDATE", "1".into()),
                ("OPENCODE_PERMISSION", r#"{"*":"deny"}"#.into()),
                (
                    "OPENCODE_CONFIG_CONTENT",
                    r#"{"permission":{"*":"deny"},"share":"disabled","autoupdate":false,"mcp":{}}"#
                        .into(),
                ),
            ]);
        }
        let environment: Vec<(&str, &OsStr)> = environment
            .iter()
            .map(|(name, value)| (*name, value.as_os_str()))
            .collect();
        let args: &[&str] = if grok {
            &[
                "--tools",
                "",
                "--disable-web-search",
                "--no-subagents",
                "--permission-mode",
                "dontAsk",
                "--deny",
                "Bash",
                "--deny",
                "Edit",
                "--deny",
                "Read",
                "--deny",
                "Grep",
                "--deny",
                "MCPTool",
                "agent",
                "--no-leader",
                "stdio",
            ]
        } else {
            &["acp", "--pure"]
        };
        let args = args.iter().map(OsStr::new).collect::<Vec<_>>();
        let mut rpc = Rpc::spawn(&exe, &args, &cwd, &environment, true)?;
        let deadline = Instant::now() + Duration::from_secs(45);
        let init = rpc.request_with("initialize", json!({
            "protocolVersion": 1,
            "clientInfo": { "name": "lab_m4", "title": "Lab-M4", "version": "1.1" },
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
        }), cancel, deadline, |_| Ok(()))?;
        if init["protocolVersion"] != 1 {
            return Err(format!(
                "{} používa nepodporovanú verziu ACP.",
                platform.label()
            ));
        }
        if grok {
            let methods = init["authMethods"].as_array();
            let supports =
                |id| methods.is_some_and(|entries| entries.iter().any(|method| method["id"] == id));
            let method = if env::var_os("XAI_API_KEY").is_some() && supports("xai.api_key") {
                "xai.api_key"
            } else if supports("cached_token") {
                "cached_token"
            } else {
                return Err("Grok Build vyžaduje prihlásenie cez grok login.".into());
            };
            rpc.request_with(
                "authenticate",
                json!({ "methodId": method, "_meta": { "headless": true } }),
                cancel,
                deadline,
                |_| Ok(()),
            )
            .map_err(|_| "Grok Build neprijal prihlásenie. Skontroluj grok login.")?;
        }
        let opened = rpc.request_with(
            "session/new",
            json!({ "cwd": cwd, "mcpServers": [] }),
            cancel,
            deadline,
            |_| Ok(()),
        )?;
        let id = opened["sessionId"]
            .as_str()
            .ok_or("CLI nevytvorilo konverzáciu.")?
            .to_owned();
        let (model_config, default_model, catalog) = catalog(&opened);
        Ok(Self {
            rpc,
            id,
            catalog,
            model_config,
            current_model: default_model.clone(),
            default_model,
            thinking: ThinkingConfig::from_config(&opened),
        })
    }

    pub(super) fn catalog(
        &mut self,
        model: Option<&str>,
        cancel: &AtomicBool,
    ) -> Result<ModelCatalog, String> {
        self.select_model(model, cancel, Instant::now() + Duration::from_secs(30))?;
        Ok(ModelCatalog {
            models: self.catalog.clone(),
            default_model: self.default_model.clone(),
            options: ModelOptions {
                speed: Vec::new(),
                thinking: self
                    .thinking
                    .as_ref()
                    .map(|option| option.choices.clone())
                    .unwrap_or_default(),
            },
        })
    }

    fn select_model(
        &mut self,
        model: Option<&str>,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        let model = model
            .map(str::to_owned)
            .or_else(|| self.default_model.clone());
        let model = model.as_deref();
        if let Some(model) = model.filter(|value| Some(*value) != self.current_model.as_deref()) {
            self.set_thinking(None, cancel, deadline)?;
            let (method, params) = if let Some(config) = &self.model_config {
                (
                    "session/set_config_option",
                    json!({"sessionId": self.id, "configId": config, "value": model}),
                )
            } else {
                (
                    "session/set_model",
                    json!({"sessionId": self.id, "modelId": model}),
                )
            };
            let result = self
                .rpc
                .request_with(method, params, cancel, deadline, |_| Ok(()))?;
            if self.model_config.is_some()
                && model_option(&result).and_then(|option| option["currentValue"].as_str())
                    != Some(model)
            {
                return Err("CLI nepotvrdilo vybraný model.".into());
            }

            self.current_model = Some(model.to_owned());
            self.thinking = ThinkingConfig::from_config(&result);
        }
        Ok(())
    }

    fn set_thinking(
        &mut self,
        value: Option<&str>,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        let unavailable = || "Vybraný model tento thinking režim neponúka.".to_owned();
        let Some(option) = self.thinking.as_mut() else {
            return value.map_or(Ok(()), |_| Err(unavailable()));
        };
        let value = value.unwrap_or(&option.initial);
        if value == option.current {
            return Ok(());
        }
        if !option.choices.iter().any(|choice| choice.id == value) {
            return Err(unavailable());
        }
        let result = self.rpc.request_with(
            "session/set_config_option",
            json!({"sessionId": self.id, "configId": option.id, "value": value}),
            cancel,
            deadline,
            |_| Ok(()),
        )?;
        let confirmed = ThinkingConfig::from_config(&result)
            .filter(|updated| updated.current == value)
            .ok_or("CLI nepotvrdilo thinking režim.")?;
        option.current = confirmed.current;
        Ok(())
    }

    pub(super) fn answer(&mut self, turn: &Turn) -> Result<String, String> {
        let deadline = Instant::now() + TURN_TIMEOUT;
        if turn.speed.is_some() {
            return Err("Toto CLI neposkytuje výber rýchlosti.".into());
        }
        self.select_model(turn.model.as_deref(), &turn.cancel, deadline)?;
        self.set_thinking(turn.thinking.as_deref(), &turn.cancel, deadline)?;
        let mut answer = String::new();
        let completed = self.rpc.request_with(
            "session/prompt",
            json!({
                "sessionId": self.id,
                "prompt": [{ "type": "text", "text": turn.message }],
            }),
            &turn.cancel,
            deadline,
            |frame| {
                let params = &frame["params"];
                let update = &params["update"];
                if frame["method"] == "session/update"
                    && params["sessionId"] == self.id
                    && update["sessionUpdate"] == "agent_message_chunk"
                {
                    if let Some(text) = update["content"]["text"].as_str() {
                        if answer.len() + text.len() > ANSWER_LIMIT {
                            return Err("Odpoveď modelu je príliš veľká.".into());
                        }
                        answer.push_str(text);
                        let _ = turn.window.emit(
                            "chat-delta",
                            ChatDelta {
                                request_id: turn.request_id,
                                text,
                            },
                        );
                    }
                }
                Ok(())
            },
        )?;
        if completed["stopReason"] != "end_turn" || answer.trim().is_empty() {
            return Err("CLI nedokončilo textovú odpoveď. Skontroluj prihlásenie a model.".into());
        }
        Ok(answer)
    }
}
