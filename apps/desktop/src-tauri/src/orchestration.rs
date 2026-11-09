use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{
    mpsc::{self, SyncSender},
    Arc, Mutex,
};
use tauri::AppHandle;

#[derive(Deserialize)]
struct Agent {
    provider: String,
    model: Option<String>,
}

#[derive(Deserialize)]
struct Check {
    executable: String,
    args: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct Settings {
    project: String,
    files: Vec<String>,
    task: String,
    manager: Agent,
    workers: Vec<Agent>,
    check: Option<Check>,
}

/// Most recent agent activity events kept per run for the terminal/chat activity view.
const MAX_EVENTS: usize = 4000;
/// Activity events are short status lines; anything larger is dropped rather than stored.
const MAX_EVENT_BYTES: usize = 16 * 1024;

/// Bounded, append-only activity log. `offset` counts events evicted from the front so
/// clients can resume with the absolute index they have already seen.
#[derive(Default)]
struct EventLog {
    offset: u64,
    items: VecDeque<Value>,
}

impl EventLog {
    fn push(&mut self, event: Value) -> bool {
        if !event.is_object()
            || serde_json::to_vec(&event).map_or(true, |bytes| bytes.len() > MAX_EVENT_BYTES)
        {
            return false;
        }
        self.items.push_back(event);
        while self.items.len() > MAX_EVENTS {
            self.items.pop_front();
            self.offset += 1;
        }
        true
    }

    fn total(&self) -> u64 {
        self.offset + self.items.len() as u64
    }

    /// Events with an absolute index of at least `since`, plus the index of the first one returned.
    fn since(&self, since: u64) -> (u64, Vec<Value>) {
        let start = since.clamp(self.offset, self.total());
        let skip = usize::try_from(start - self.offset).unwrap_or(usize::MAX);
        (start, self.items.iter().skip(skip).cloned().collect())
    }
}

struct Run {
    id: u32,
    stage: String,
    approval: Option<Value>,
    result: Option<Value>,
    error: Option<String>,
    commands: Option<SyncSender<Value>>,
    events: EventLog,
}

#[derive(Clone, Default)]
pub(crate) struct OrchestrationState(Arc<Mutex<Option<Run>>>);

impl OrchestrationState {
    pub(crate) fn close(&self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(run) = slot.as_mut().filter(|run| run.commands.is_some()) {
                let _ = stop(run);
            }
        }
    }
}

fn stop(run: &mut Run) -> Result<(), String> {
    if run.stage != "stopping" {
        send(run, json!({"type": "stop"}))?;
        run.stage = "stopping".into();
        run.approval = None;
    }
    Ok(())
}

fn send(run: &Run, message: Value) -> Result<(), String> {
    run.commands
        .as_ref()
        .ok_or("Beh sa už skončil.")?
        .try_send(message)
        .map_err(|_| "Príkaz sa nepodarilo doručiť.".into())
}

#[tauri::command]
pub(crate) fn orchestration_snapshot(
    state: tauri::State<'_, OrchestrationState>,
    since: Option<u64>,
) -> Result<Value, String> {
    let slot = state.0.lock().map_err(|_| "Orchestrátor je nedostupný.")?;
    Ok(slot
        .as_ref()
        .map_or(Value::Null, |run| snapshot(run, since)))
}

fn snapshot(run: &Run, since: Option<u64>) -> Value {
    let (event_start, events) = run.events.since(since.unwrap_or(0));
    json!({
        "id": run.id, "stage": run.stage, "approval": run.approval,
        "result": run.result, "error": run.error,
        "eventStart": event_start, "eventTotal": run.events.total(), "events": events,
    })
}

#[tauri::command]
pub(crate) fn orchestration_action(
    state: tauri::State<'_, OrchestrationState>,
    id: u32,
    action: String,
    approval_id: Option<u32>,
) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|_| "Orchestrátor je nedostupný.")?;
    let run = slot
        .as_mut()
        .filter(|run| run.id == id && run.commands.is_some())
        .ok_or("Tento beh už nie je aktívny.")?;
    if action == "stop" {
        return stop(run);
    }
    if !matches!(action.as_str(), "approve" | "deny")
        || approval_id.map(u64::from)
            != run.approval.as_ref().and_then(|value| value["id"].as_u64())
        || approval_id.is_none()
    {
        return Err("Toto schválenie už nie je aktívne.".into());
    }
    send(
        run,
        json!({"type": "decision", "id": approval_id, "allow": action == "approve"}),
    )?;
    run.approval = None;
    run.stage = "working".into();
    Ok(())
}

#[tauri::command]
pub(crate) fn orchestration_start(
    app: AppHandle,
    state: tauri::State<'_, OrchestrationState>,
    settings: Settings,
) -> Result<u32, String> {
    let mut slot = state.0.lock().map_err(|_| "Orchestrátor je nedostupný.")?;
    if slot.as_ref().is_some_and(|run| run.commands.is_some()) {
        return Err("Orchestrátor už pracuje.".into());
    }
    let id = slot.as_ref().map_or(1, |run| run.id.wrapping_add(1));
    let (commands, receiver) = mpsc::sync_channel(4);
    *slot = Some(Run {
        id,
        commands: Some(commands),
        stage: "starting".into(),
        approval: None,
        result: None,
        error: None,
        events: EventLog::default(),
    });
    let worker_state = state.inner().clone();
    let started = std::thread::Builder::new()
        .name("lab-m4-orchestration".into())
        .spawn(move || {
            let result = execute(&app, &worker_state, id, settings, receiver);
            if let Ok(mut slot) = worker_state.0.lock() {
                if let Some(run) = slot.as_mut().filter(|run| run.id == id) {
                    run.approval = None;
                    run.commands = None;
                    match result {
                        Ok(result) => {
                            run.stage = if result["status"] == "cancelled" {
                                "cancelled"
                            } else {
                                "finished"
                            }
                            .into();
                            run.result = Some(result);
                        }
                        Err(error) => {
                            run.stage = "failed".into();
                            run.error = Some(error);
                        }
                    }
                }
            }
        });
    if started.is_err() {
        *slot = None;
        return Err("Orchestrátor sa nepodarilo spustiť.".into());
    }
    Ok(id)
}

#[cfg(not(windows))]
fn execute(
    _: &AppHandle,
    _: &OrchestrationState,
    _: u32,
    settings: Settings,
    _: mpsc::Receiver<Value>,
) -> Result<Value, String> {
    let Settings {
        project,
        files,
        task,
        manager,
        workers,
        check,
    } = settings;
    let Agent { provider, model } = manager;
    if let Some(Check { executable, args }) = check {
        drop((executable, args));
    }
    drop((project, files, task, provider, model, workers));
    Err("Orchestrátor je dostupný vo Windows.".into())
}

#[cfg(windows)]
fn execute(
    app: &AppHandle,
    state: &OrchestrationState,
    id: u32,
    settings: Settings,
    commands: mpsc::Receiver<Value>,
) -> Result<Value, String> {
    use crate::job_supervisor::Supervised;
    use std::{
        env,
        ffi::{OsStr, OsString},
        io::{BufRead, BufReader, Read, Write},
        path::Path,
        time::{Duration, Instant},
    };
    use tauri::Manager;

    const MAX_FRAME: u64 = 4 * 1024 * 1024;
    let cancelled = || json!({"status": "cancelled"});
    let valid_agent = |agent: Agent| -> Result<Value, String> {
        let executable = crate::chat::orchestration_executable(&agent.provider)?;
        let mut value = json!({"provider":agent.provider,"executable":executable});
        if let Some(model) = agent.model {
            value["model"] = Value::String(model);
        }
        Ok(value)
    };
    if !Path::new(&settings.project).is_absolute()
        || settings.project.len() > 32_000
        || !(1..=12).contains(&settings.files.len())
        || settings.files.iter().any(|path| path.len() > 180)
        || !(2..=8).contains(&settings.workers.len())
        || settings.task.trim().is_empty()
        || settings.task.len() > 32_000
        || settings.check.as_ref().is_some_and(|check| {
            !Path::new(&check.executable).is_absolute()
                || check.executable.len() > 32_000
                || check.args.len() > 32
                || check.args.iter().any(|arg| arg.len() > 1024)
        })
    {
        return Err("Skontroluj priečinok, rozsah súborov, zadanie a nastavenia testu.".into());
    }
    let runtime = crate::usage::packaged_runtime(app)?;
    let manager = valid_agent(settings.manager)?;
    let workers = settings
        .workers
        .into_iter()
        .map(valid_agent)
        .collect::<Result<Vec<_>, _>>()?;
    let mut request = json!({
        "transport":runtime.join("agent_transport.exe"), "project":settings.project,
        "files":settings.files, "task":settings.task, "manager":manager, "workers":workers,
    });
    if let Some(check) = settings.check {
        request["check"] = json!({"executable":check.executable,"args":check.args});
    }
    let data = app
        .path()
        .app_local_data_dir()
        .or_else(|_| crate::user_home().map(|home| home.join(".lab-m4")))?;
    let scratch = data.join("orchestration");
    std::fs::create_dir_all(&scratch).map_err(|_| "Pracovný priečinok sa nedá vytvoriť.")?;
    if commands
        .try_recv()
        .is_ok_and(|message| message["type"] == "stop")
    {
        return Ok(cancelled());
    }
    let env: Vec<(&str, OsString)> = [
        "SystemRoot",
        "WINDIR",
        "PATH",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "CODEX_HOME",
        "OPENAI_API_KEY",
        "GROK_HOME",
        "XAI_API_KEY",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "OPENCODE_DB",
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GEMINI_API_KEY",
        "OPENCODE_API_KEY",
    ]
    .into_iter()
    .filter_map(|name| env::var_os(name).map(|value| (name, value)))
    .chain([
        ("TMP", scratch.clone().into_os_string()),
        ("TEMP", scratch.into_os_string()),
    ])
    .collect();
    let env: Vec<(&str, &OsStr)> = env
        .iter()
        .map(|(name, value)| (*name, value.as_os_str()))
        .collect();
    let entry = runtime.join("orchestration.cjs");
    let (process, mut pipes) = Supervised::spawn(
        &runtime.join("node.exe"),
        &[entry.as_os_str()],
        &runtime,
        &env,
    )
    .map_err(|_| "Nepodarilo sa spustiť jadro orchestrátora.")?;
    let write = |stdin: &mut std::fs::File, value: Value| -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "Neplatná požiadavka.")?;
        bytes.push(b'\n');
        stdin
            .write_all(&bytes)
            .map_err(|_| "Spojenie s orchestrátorom sa ukončilo.".into())
    };
    let (events, receiver) = mpsc::sync_channel(4);
    std::thread::spawn(move || {
        let mut stdout = BufReader::new(pipes.stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match stdout
                .by_ref()
                .take(MAX_FRAME + 1)
                .read_until(b'\n', &mut line)
            {
                Ok(size) if size > 0 && size as u64 <= MAX_FRAME && line.last() == Some(&b'\n') => {
                    let Ok(frame) = serde_json::from_slice::<Value>(&line) else {
                        break;
                    };
                    if events.send(frame).is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
    });
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut pipes.stderr, &mut std::io::sink());
    });
    write(&mut pipes.stdin, json!({"type":"start","settings":request}))?;

    let mut stopping = None;
    let result = loop {
        while let Ok(message) = commands.try_recv() {
            if message["type"] == "stop" {
                stopping = Some(Instant::now() + Duration::from_secs(8));
            }
            if write(&mut pipes.stdin, message).is_err() && stopping.is_none() {
                break;
            }
        }
        if stopping.is_some_and(|deadline| Instant::now() >= deadline) {
            break Ok(cancelled());
        }
        let frame = match receiver.recv_timeout(Duration::from_millis(35)) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) if stopping.is_some() => {
                break Ok(cancelled())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err("Spojenie s orchestrátorom sa ukončilo.".into())
            }
        };
        match frame["type"].as_str() {
            Some("result") => {
                break Ok(
                    if stopping.is_some() && frame["result"]["status"] != "cancelled" {
                        cancelled()
                    } else {
                        frame["result"].clone()
                    },
                )
            }
            Some("error") if stopping.is_some() => break Ok(cancelled()),
            Some("error") => {
                break Err(frame["error"]
                    .as_str()
                    .unwrap_or("Orchestrátor zlyhal.")
                    .into())
            }
            Some("event") => {
                if let Ok(mut slot) = state.0.lock() {
                    if let Some(run) = slot.as_mut().filter(|run| run.id == id) {
                        run.events.push(frame["event"].clone());
                    }
                }
            }
            Some("approval" | "stage") if stopping.is_none() => {
                if let Ok(mut slot) = state.0.lock() {
                    if let Some(run) = slot
                        .as_mut()
                        .filter(|run| run.id == id && run.stage != "stopping")
                    {
                        if frame["type"] == "approval" {
                            run.stage = "approval".into();
                            run.approval = Some(frame);
                        } else if let Some(stage) = frame["stage"].as_str() {
                            run.stage = stage.into();
                        }
                    }
                }
            }
            _ => {}
        }
    };
    process
        .stop(Duration::from_secs(3))
        .map_err(|_| "Windows nepotvrdil ukončenie procesov.")?;
    let active = process
        .active_count()
        .map_err(|_| "Windows nepotvrdil stav procesov.")?;
    if active != 0 {
        return Err("Niektoré procesy stále bežia.".into());
    }
    result.map(|mut value| {
        value["cleanupConfirmed"] = Value::Bool(true);
        value
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_with(log: EventLog) -> Run {
        Run {
            id: 7,
            stage: "working".into(),
            approval: None,
            result: None,
            error: None,
            commands: None,
            events: log,
        }
    }

    #[test]
    fn event_log_returns_only_new_events() {
        let mut log = EventLog::default();
        for index in 0..3 {
            assert!(log.push(json!({"type": "stage", "index": index})));
        }
        let (start, events) = log.since(1);
        assert_eq!(start, 1);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["index"], 1);
        assert_eq!(log.since(3).1.len(), 0);
        assert_eq!(log.since(99), (3, vec![]));
    }

    #[test]
    fn event_log_rejects_invalid_and_oversized_events() {
        let mut log = EventLog::default();
        assert!(!log.push(Value::Null));
        assert!(!log.push(json!("text")));
        assert!(!log.push(json!({"type": "x", "text": "a".repeat(MAX_EVENT_BYTES)})));
        assert_eq!(log.total(), 0);
    }

    #[test]
    fn event_log_is_bounded_and_keeps_absolute_indices() {
        let mut log = EventLog::default();
        for index in 0..(MAX_EVENTS + 5) {
            log.push(json!({"type": "stage", "index": index}));
        }
        assert_eq!(log.items.len(), MAX_EVENTS);
        assert_eq!(log.total(), (MAX_EVENTS + 5) as u64);
        let (start, events) = log.since(0);
        assert_eq!(start, 5);
        assert_eq!(events[0]["index"], 5);
    }

    #[test]
    fn snapshot_includes_event_window() {
        let mut log = EventLog::default();
        log.push(json!({"type": "plan"}));
        log.push(json!({"type": "worker-start"}));
        let value = snapshot(&run_with(log), Some(1));
        assert_eq!(value["id"], 7);
        assert_eq!(value["eventStart"], 1);
        assert_eq!(value["eventTotal"], 2);
        assert_eq!(value["events"][0]["type"], "worker-start");
    }
}
