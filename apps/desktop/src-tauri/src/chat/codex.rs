use super::{ChatDelta, Choice, Model, ModelCatalog, ModelOptions, Turn};
use crate::job_supervisor::Supervised;
use serde_json::{json, Value};
use std::{
    env,
    ffi::{OsStr, OsString},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;

const FRAME_LIMIT: usize = 1024 * 1024;
pub(super) const ANSWER_LIMIT: usize = 256 * 1024;
pub(super) const TURN_TIMEOUT: Duration = Duration::from_secs(180);

pub(super) fn executable() -> Option<PathBuf> {
    let architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let target = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    let bundled = env::var_os("APPDATA").map(PathBuf::from).map(|directory| {
        directory
            .join("npm/node_modules/@openai/codex/node_modules")
            .join(format!(
                "@openai/codex-win32-{architecture}/vendor/{target}-pc-windows-msvc/bin/codex.exe"
            ))
    });
    let path = env::var_os("PATH").unwrap_or_default();
    env::var_os("LAB_M4_CODEX_EXE")
        .map(PathBuf::from)
        .into_iter()
        .chain(bundled)
        .chain(
            env::split_paths(&path)
                .filter(|dir| dir.is_absolute())
                .map(|dir| dir.join("codex.exe")),
        )
        .find(|file| {
            file.is_absolute()
                && file
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("codex.exe"))
                && file.is_file()
        })
}

impl Session {
    pub(super) fn start(cancel: &AtomicBool) -> Result<Self, String> {
        let exe = executable()
            .ok_or("Nenašiel som Codex CLI. Nainštaluj ho a prihlás sa cez codex login.")?;
        let cwd = crate::user_home()?.join(".lab-m4").join("chat");
        std::fs::create_dir_all(&cwd).map_err(|_| "Chat nemá pracovný priečinok.")?;
        let system =
            PathBuf::from(env::var_os("SystemRoot").ok_or("Chýba systémový priečinok Windows.")?);
        let bin = exe.parent().ok_or("Neplatná cesta ku Codex CLI.")?;
        let path = env::join_paths([bin, &system.join("System32")])
            .map_err(|_| "Neplatná cesta ku Codex CLI.")?;
        let mut environment: Vec<(&str, OsString)> = [
            "SystemRoot",
            "WINDIR",
            "USERPROFILE",
            "HOME",
            "APPDATA",
            "LOCALAPPDATA",
            "CODEX_HOME",
            "TEMP",
            "TMP",
            "OPENAI_API_KEY",
        ]
        .into_iter()
        .filter_map(|name| env::var_os(name).map(|value| (name, value)))
        .collect();
        environment.push(("PATH", path));
        let environment: Vec<(&str, &OsStr)> = environment
            .iter()
            .map(|(name, value)| (*name, value.as_os_str()))
            .collect();
        let args: Vec<&OsStr> = [
            "app-server",
            "--stdio",
            "--disable",
            "shell_tool",
            "--disable",
            "multi_agent",
            "--disable",
            "multi_agent_v2",
            "--disable",
            "apps",
            "--disable",
            "hooks",
            "--disable",
            "plugins",
            "-c",
            "mcp_servers={}",
            "-c",
            "web_search=\"disabled\"",
        ]
        .iter()
        .map(OsStr::new)
        .collect();
        let mut rpc = Rpc::spawn(&exe, &args, &cwd, &environment, false)?;
        let deadline = Instant::now() + Duration::from_secs(30);
        rpc.request(
            "initialize",
            json!({
                "clientInfo": { "name": "lab_m4", "title": "Lab-M4", "version": "1.1" }
            }),
            cancel,
            deadline,
            &mut Vec::new(),
        )?;
        rpc.write(json!({"method": "initialized"}))?;
        let result = rpc.request("thread/start", json!({
        "cwd": cwd, "sandbox": "read-only", "approvalPolicy": "never", "ephemeral": true,
        "developerInstructions": "You are a conversational assistant in Lab-M4. Answer in the chat. Do not use local tools, files, or network tools."
    }), cancel, deadline, &mut Vec::new())?;
        if result.pointer("/thread/ephemeral") != Some(&Value::Bool(true))
            || result["sandbox"]["type"] != "readOnly"
            || result["sandbox"]["networkAccess"] != false
            || result["approvalPolicy"] != "never"
        {
            return Err("Codex nepotvrdil obmedzenia bezpečného režimu chatu.".into());
        }
        let thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("Codex nevytvoril konverzáciu.")?
            .to_owned();
        let default_model = result["model"].as_str().map(str::to_owned);
        Ok(Session {
            rpc,
            thread_id,
            default_model,
            default_thinking: result["reasoningEffort"].as_str().map(str::to_owned),
            models: None,
        })
    }
}

pub(super) struct Session {
    rpc: Rpc,
    thread_id: String,
    default_model: Option<String>,
    default_thinking: Option<String>,
    models: Option<Vec<Model>>,
}

fn codex_model(model: &Value) -> Option<Model> {
    let id = model["model"].as_str()?;
    let mut speed: Vec<_> = model["serviceTiers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tier| {
            let id = tier["id"].as_str()?;
            Some(Choice {
                id: id.into(),
                name: tier["name"].as_str().unwrap_or(id).into(),
                description: tier["description"].as_str().map(str::to_owned),
            })
        })
        .collect();
    if !speed.is_empty() && !speed.iter().any(|tier| tier.id == "default") {
        speed.insert(
            0,
            Choice {
                id: "default".into(),
                name: "Štandardná".into(),
                description: None,
            },
        );
    }
    let thinking = model["supportedReasoningEfforts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|effort| {
            let id = effort["reasoningEffort"].as_str()?;
            Some(Choice {
                id: id.into(),
                name: id.into(),
                description: effort["description"].as_str().map(str::to_owned),
            })
        })
        .collect();
    Some(Model {
        id: id.into(),
        name: model["displayName"].as_str().unwrap_or(id).into(),
        options: ModelOptions { speed, thinking },
        default_thinking: model["defaultReasoningEffort"].as_str().map(str::to_owned),
    })
}
impl Session {
    pub(super) fn catalog(&mut self, cancel: &AtomicBool) -> Result<ModelCatalog, String> {
        if self.models.is_none() {
            self.models = Some(self.read_models(cancel)?);
        }
        Ok(ModelCatalog {
            models: self.models.clone().unwrap_or_default(),
            default_model: self.default_model.clone(),
            options: ModelOptions::default(),
        })
    }

    fn read_models(&mut self, cancel: &AtomicBool) -> Result<Vec<Model>, String> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..8 {
            let result = self.rpc.request(
                "model/list",
                json!({ "cursor": cursor, "limit": 100 }),
                cancel,
                deadline,
                &mut Vec::new(),
            )?;
            models.extend(
                result["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(codex_model),
            );
            let next = result["nextCursor"].as_str().map(str::to_owned);
            if next.is_none() || next == cursor {
                break;
            }
            cursor = next;
        }
        Ok(models)
    }

    pub(super) fn answer(&mut self, turn: &Turn) -> Result<String, String> {
        let deadline = Instant::now() + TURN_TIMEOUT;
        if self.models.is_none() && (turn.speed.is_some() || turn.thinking.is_some()) {
            self.models = Some(self.read_models(&turn.cancel)?);
        }
        let model_id = turn.model.as_ref().or(self.default_model.as_ref());
        let model = self
            .models
            .iter()
            .flatten()
            .find(|item| Some(&item.id) == model_id);
        if turn.speed.as_ref().is_some_and(|id| {
            !model.is_some_and(|item| item.options.speed.iter().any(|option| &option.id == id))
        }) {
            return Err("Vybraný model túto rýchlosť neponúka.".into());
        }
        if turn.thinking.as_ref().is_some_and(|id| {
            !model.is_some_and(|item| item.options.thinking.iter().any(|option| &option.id == id))
        }) {
            return Err("Vybraný model tento thinking režim neponúka.".into());
        }
        let default_thinking = if model_id == self.default_model.as_ref() {
            self.default_thinking
                .as_ref()
                .or_else(|| model.and_then(|item| item.default_thinking.as_ref()))
        } else {
            model.and_then(|item| item.default_thinking.as_ref())
        };
        let mut early_events = Vec::new();
        let started = self.rpc.request(
            "turn/start",
            json!({
                "threadId": self.thread_id,
                "model": model_id,
                "effort": turn.thinking.as_ref().or(default_thinking),
                "serviceTierForTurn": turn.speed,
                "input": [{ "type": "text", "text": turn.message, "text_elements": [] }]
            }),
            &turn.cancel,
            deadline,
            &mut early_events,
        )?;
        let turn_id = started
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or("Codex nepotvrdil prijatie správy.")?;
        let mut early_events = early_events.into_iter();
        let mut answer = String::new();
        let mut final_answer = String::new();
        let mut streamed_bytes = 0;
        loop {
            let frame = match early_events.next() {
                Some(frame) => frame,
                None => self.rpc.read(&turn.cancel, deadline)?,
            };
            let params = &frame["params"];
            if params["threadId"].as_str() != Some(self.thread_id.as_str()) {
                continue;
            }
            match frame["method"].as_str() {
                Some("item/agentMessage/delta") if params["turnId"].as_str() == Some(turn_id) => {
                    if let Some(text) = params["delta"].as_str() {
                        streamed_bytes += text.len();
                        if streamed_bytes > ANSWER_LIMIT {
                            return Err("Odpoveď modelu je príliš veľká.".into());
                        }
                        let _ = turn.window.emit(
                            "chat-delta",
                            ChatDelta {
                                request_id: turn.request_id,
                                text,
                            },
                        );
                    }
                }
                Some("item/completed")
                    if params["turnId"].as_str() == Some(turn_id)
                        && params["item"]["type"] == "agentMessage" =>
                {
                    if let Some(text) = params["item"]["text"].as_str() {
                        if text.len() > ANSWER_LIMIT {
                            return Err("Odpoveď modelu je príliš veľká.".into());
                        }
                        if params["item"]["phase"] == "final_answer" {
                            final_answer = text.to_owned();
                        } else {
                            answer = text.to_owned();
                        }
                    }
                }
                Some("turn/completed") if params["turn"]["id"].as_str() == Some(turn_id) => {
                    if params["turn"]["status"] != "completed" {
                        return Err(
                            "Codex nedokončil odpoveď. Skontroluj prihlásenie a dostupnosť modelu."
                                .into(),
                        );
                    }
                    let text = if final_answer.is_empty() {
                        answer
                    } else {
                        final_answer
                    };
                    return if text.trim().is_empty() {
                        Err("Model neposlal textovú odpoveď.".into())
                    } else {
                        Ok(text)
                    };
                }
                _ => {}
            }
        }
    }
}

pub(super) struct Rpc {
    job: Supervised,
    input: mpsc::SyncSender<Value>,
    output: mpsc::Receiver<Result<Value, ()>>,
    next: u32,
    jsonrpc: bool,
}

impl Rpc {
    pub(super) fn spawn(
        exe: &Path,
        args: &[&OsStr],
        cwd: &Path,
        environment: &[(&str, &OsStr)],
        jsonrpc: bool,
    ) -> Result<Self, String> {
        let (job, pipes) = Supervised::spawn(exe, args, cwd, environment)
            .map_err(|_| "Nepodarilo sa bezpečne spustiť vybrané CLI.")?;
        let (input, writes) = mpsc::sync_channel::<Value>(4);
        let (frames, output) = mpsc::sync_channel(32);
        std::thread::spawn(move || {
            let mut stdin = pipes.stdin;
            while let Ok(value) = writes.recv() {
                if serde_json::to_writer(&mut stdin, &value).is_err()
                    || stdin.write_all(b"\n").is_err()
                {
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            let mut stdout = BufReader::new(pipes.stdout);
            loop {
                let mut line = Vec::new();
                match (&mut stdout)
                    .take((FRAME_LIMIT + 1) as u64)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break,
                    Ok(size) if size <= FRAME_LIMIT && line.last() == Some(&b'\n') => {
                        if frames
                            .send(serde_json::from_slice(&line).map_err(|_| ()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    _ => {
                        let _ = frames.send(Err(()));
                        break;
                    }
                }
            }
        });
        std::thread::spawn(move || {
            let _ = io::copy(&mut &pipes.stderr, &mut io::sink());
        });
        Ok(Self {
            job,
            input,
            output,
            next: 0,
            jsonrpc,
        })
    }

    fn write(&self, mut frame: Value) -> Result<(), String> {
        if self.jsonrpc {
            frame["jsonrpc"] = json!("2.0");
        }
        self.input
            .try_send(frame)
            .map_err(|_| "CLI neprijíma správy.".into())
    }

    fn read(&self, cancel: &AtomicBool, deadline: Instant) -> Result<Value, String> {
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err("Odpoveď bola zastavená.".into());
            }
            if Instant::now() >= deadline {
                return Err("CLI neodpovedalo v časovom limite.".into());
            }
            match self.output.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(frame)) if frame.get("id").is_some() && frame.get("method").is_some() => {
                    self.write(json!({"id": frame["id"], "error": {"code": -32601, "message": "Action unavailable in chat mode"}}))?;
                }
                Ok(Ok(frame)) => return Ok(frame),
                Ok(Err(())) => return Err("CLI poslalo neplatnú odpoveď.".into()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(
                        "CLI ukončilo pripojenie. Skontroluj jeho verziu a prihlásenie.".into(),
                    );
                }
            }
        }
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        cancel: &AtomicBool,
        deadline: Instant,
        notifications: &mut Vec<Value>,
    ) -> Result<Value, String> {
        self.request_with(method, params, cancel, deadline, |frame| {
            if method == "turn/start"
                && frame["method"].as_str().is_some_and(|name| {
                    matches!(
                        name,
                        "item/agentMessage/delta" | "item/completed" | "turn/completed"
                    )
                })
            {
                if notifications.len() >= 32 {
                    return Err("Codex poslal príliš veľa udalostí pred potvrdením správy.".into());
                }
                notifications.push(frame);
            }
            Ok(())
        })
    }

    pub(super) fn request_with(
        &mut self,
        method: &str,
        params: Value,
        cancel: &AtomicBool,
        deadline: Instant,
        mut notify: impl FnMut(Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        self.next += 1;
        self.write(json!({"method": method, "id": self.next, "params": params}))?;
        loop {
            let frame = self.read(cancel, deadline)?;
            if frame["id"].as_u64() == Some(u64::from(self.next)) {
                return frame.get("result").cloned().ok_or_else(||
                    "CLI odmietlo požiadavku. Skontroluj prihlásenie a dostupnosť vybraného modelu.".into());
            }
            notify(frame)?;
        }
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        let _ = self.job.stop(Duration::from_secs(2));
    }
}
