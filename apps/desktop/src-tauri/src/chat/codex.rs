#[path = "../../../../../packages/orchestrator-core/native/job_supervisor.rs"]
mod job_supervisor;

use super::{ChatDelta, Turn};
use job_supervisor::Supervised;
use serde_json::{json, Value};
use std::{
    env,
    ffi::{OsStr, OsString},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, mpsc},
    time::{Duration, Instant},
};
use tauri::Emitter;

const FRAME_LIMIT: usize = 1024 * 1024;
const ANSWER_LIMIT: usize = 256 * 1024;
const TURN_TIMEOUT: Duration = Duration::from_secs(180);

fn executable() -> Option<PathBuf> {
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

fn start(turn: &Turn) -> Result<Session, String> {
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
    let mut rpc = Rpc::spawn(&exe, &args, &cwd, &environment)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    rpc.request(
        "initialize",
        json!({
            "clientInfo": { "name": "lab_m4", "title": "Lab-M4", "version": "1.1" }
        }),
        turn,
        deadline,
        &mut Vec::new(),
    )?;
    rpc.write(json!({"method": "initialized"}))?;
    let result = rpc.request("thread/start", json!({
        "cwd": cwd, "sandbox": "read-only", "approvalPolicy": "never", "ephemeral": true,
        "developerInstructions": "You are a conversational assistant in Lab-M4. Answer in the chat. Do not use local tools, files, or network tools."
    }), turn, deadline, &mut Vec::new())?;
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
    Ok(Session { rpc, thread_id })
}

pub(super) struct Session {
    rpc: Rpc,
    thread_id: String,
}

pub(super) fn send(session: &mut Option<Session>, turn: &Turn) -> Result<String, String> {
    if turn.cancel.load(Ordering::Acquire) {
        return Err("Odpoveď bola zastavená.".into());
    }
    if session.is_none() {
        *session = Some(start(turn)?);
    }
    let result = session.as_mut().expect("initialized session").answer(turn);
    if result.is_err() {
        session.take();
    }
    result
}

impl Session {
    fn answer(&mut self, turn: &Turn) -> Result<String, String> {
        let deadline = Instant::now() + TURN_TIMEOUT;
        let mut early_events = Vec::new();
        let started = self.rpc.request(
            "turn/start",
            json!({
                "threadId": self.thread_id,
                "input": [{ "type": "text", "text": turn.message, "text_elements": [] }]
            }),
            turn,
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
                None => self.rpc.read(turn, deadline)?,
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

struct Rpc {
    job: Supervised,
    input: mpsc::SyncSender<Value>,
    output: mpsc::Receiver<Result<Value, ()>>,
    next: u32,
}

impl Rpc {
    fn spawn(
        exe: &Path,
        args: &[&OsStr],
        cwd: &Path,
        environment: &[(&str, &OsStr)],
    ) -> Result<Self, String> {
        let (job, pipes) = Supervised::spawn(exe, args, cwd, environment)
            .map_err(|_| "Nepodarilo sa bezpečne spustiť Codex CLI.")?;
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
        })
    }

    fn write(&self, frame: Value) -> Result<(), String> {
        self.input
            .try_send(frame)
            .map_err(|_| "Codex neprijíma správy.".into())
    }

    fn read(&self, turn: &Turn, deadline: Instant) -> Result<Value, String> {
        loop {
            if turn.cancel.load(Ordering::Acquire) {
                return Err("Odpoveď bola zastavená.".into());
            }
            if Instant::now() >= deadline {
                return Err("Codex neodpovedal v časovom limite.".into());
            }
            match self.output.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(frame)) if frame.get("id").is_some() && frame.get("method").is_some() => {
                    self.write(json!({"id": frame["id"], "error": {"code": -32601, "message": "Action unavailable in chat mode"}}))?;
                }
                Ok(Ok(frame)) => return Ok(frame),
                Ok(Err(())) => return Err("Codex poslal neplatnú odpoveď.".into()),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(
                        "Codex ukončil pripojenie. Skontroluj jeho verziu a prihlásenie.".into(),
                    );
                }
            }
        }
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        turn: &Turn,
        deadline: Instant,
        notifications: &mut Vec<Value>,
    ) -> Result<Value, String> {
        self.next += 1;
        self.write(json!({"method": method, "id": self.next, "params": params}))?;
        loop {
            let frame = self.read(turn, deadline)?;
            if frame["id"].as_u64() == Some(u64::from(self.next)) {
                return frame.get("result").cloned().ok_or_else(||
                    "Codex odmietol požiadavku. Skontroluj verziu CLI a prihlásenie cez codex login.".into());
            }
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
        }
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        let _ = self.job.stop(Duration::from_secs(2));
    }
}
