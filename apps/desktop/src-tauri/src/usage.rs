use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct UsageState {
    sources: Mutex<Option<HashMap<String, (String, PathBuf)>>>,
    next: AtomicU64,
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
#[derive(Serialize)]
pub struct UsageSource {
    id: String,
    agent: String,
    name: String,
}

type SourceMap = HashMap<String, (String, PathBuf)>;

fn source_list_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Data directory unavailable")?
        .join("usage")
        .join("sources.json"))
}

fn load_sources(app: &AppHandle, slot: &mut Option<SourceMap>) -> Result<(), String> {
    if slot.is_some() {
        return Ok(());
    }
    let path = source_list_path(app)?;
    let sources = match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err("Source list invalid".into());
        }
        Ok(meta) if meta.len() > 1024 * 1024 => return Err("Source list too large".into()),
        Ok(_) => {
            let bytes = std::fs::read(&path).map_err(|_| "Source list unavailable")?;
            serde_json::from_slice(&bytes).map_err(|_| "Source list invalid")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(_) => return Err("Source list unavailable".into()),
    };
    *slot = Some(sources);
    Ok(())
}

fn save_sources(app: &AppHandle, sources: &SourceMap) -> Result<(), String> {
    let path = source_list_path(app)?;
    let parent = path.parent().ok_or("Source directory unavailable")?;
    std::fs::create_dir_all(parent).map_err(|_| "Source directory unavailable")?;
    let bytes = serde_json::to_vec(sources).map_err(|_| "Source list invalid")?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock unavailable")?
        .as_nanos();
    let temp = parent.join(format!("sources-{timestamp}.tmp"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| "Source list unavailable")?;
    file.write_all(&bytes)
        .map_err(|_| "Source list unavailable")?;
    file.sync_all().map_err(|_| "Source list unavailable")?;
    drop(file);
    std::fs::rename(temp, path).map_err(|_| "Source list unavailable".to_owned())
}

#[tauri::command]
pub fn usage_list_sources(
    app: AppHandle,
    state: State<'_, UsageState>,
) -> Result<Vec<UsageSource>, String> {
    let mut slot = state
        .sources
        .lock()
        .map_err(|_| "Source state unavailable")?;
    load_sources(&app, &mut slot)?;
    let sources = slot.as_ref().ok_or("Source state unavailable")?;
    let mut result: Vec<UsageSource> = sources
        .iter()
        .map(|(id, (agent, path))| UsageSource {
            id: id.clone(),
            agent: agent.clone(),
            name: path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("source")
                .to_owned(),
        })
        .collect();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

#[tauri::command]
pub fn usage_remove_source(
    app: AppHandle,
    state: State<'_, UsageState>,
    id: String,
) -> Result<(), String> {
    let mut slot = state
        .sources
        .lock()
        .map_err(|_| "Source state unavailable")?;
    load_sources(&app, &mut slot)?;
    let sources = slot.as_mut().ok_or("Source state unavailable")?;
    let removed = sources.remove(&id).ok_or("Source not approved")?;
    if let Err(error) = save_sources(&app, sources) {
        sources.insert(id, removed);
        return Err(error);
    }
    Ok(())
}

fn safe_source(path: &Path, agent: &str) -> Result<PathBuf, String> {
    let allowed = match agent {
        "codex" | "grok-build" => ["jsonl", "zst"].as_slice(),
        "opencode" => ["db", "sqlite"].as_slice(),
        _ => return Err("Unsupported source".into()),
    };
    for component in path.ancestors() {
        if let Some(name) = component.file_name().and_then(|x| x.to_str()) {
            let lower = name.to_ascii_lowercase();
            if [
                "auth",
                "credential",
                "token",
                "secret",
                "key",
                "login",
                ".env",
            ]
            .iter()
            .any(|x| lower.contains(x))
            {
                return Err("Sensitive source denied".into());
            }
        }
        if std::fs::symlink_metadata(component)
            .map_err(|_| "Source unavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("Linked source denied".into());
        }
    }
    let metadata = std::fs::metadata(path).map_err(|_| "Source unavailable")?;
    if metadata.is_dir() {
        if agent != "codex" {
            return Err("Only Codex supports folders".into());
        }
    } else if metadata.is_file() {
        let extension = path.extension().and_then(|x| x.to_str()).unwrap_or("");
        if !allowed.iter().any(|x| extension.eq_ignore_ascii_case(x)) {
            return Err("Unsupported source".into());
        }
    } else {
        return Err("Unsupported source".into());
    }
    std::fs::canonicalize(path).map_err(|_| "Source unavailable".into())
}

#[derive(Serialize)]
pub struct UsageSuggestion {
    agent: &'static str,
    path: PathBuf,
    kind: &'static str,
}

// The locations are suggestions from docs/log-formats.md; no files are opened here.
#[tauri::command]
pub fn usage_suggest_sources() -> Result<Vec<UsageSuggestion>, String> {
    let home = super::user_home()?;
    Ok(vec![
        UsageSuggestion {
            agent: "codex",
            path: home.join(".codex").join("sessions"),
            kind: "folder",
        },
        UsageSuggestion {
            agent: "codex",
            path: home.join(".codex").join("archived_sessions"),
            kind: "folder",
        },
        UsageSuggestion {
            agent: "grok-build",
            path: home.join(".grok").join("logs").join("unified.jsonl"),
            kind: "file",
        },
        UsageSuggestion {
            agent: "opencode",
            path: home
                .join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db"),
            kind: "file",
        },
    ])
}

#[tauri::command]
pub async fn usage_select_source(
    app: AppHandle,
    state: State<'_, UsageState>,
    agent: String,
    folder: Option<bool>,
) -> Result<Option<UsageSource>, String> {
    if !["codex", "grok-build", "opencode"].contains(&agent.as_str()) {
        return Err("Unsupported source".into());
    }
    let choose_folder = folder.unwrap_or(false);
    if choose_folder && agent != "codex" {
        return Err("Only Codex supports folders".into());
    }
    let picker_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        if choose_folder {
            picker_app.dialog().file().blocking_pick_folder()
        } else {
            picker_app.dialog().file().blocking_pick_file()
        }
    })
    .await
    .map_err(|_| "Picker failed")?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| "Invalid path")?;
    let canonical = safe_source(&path, &agent)?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("source")
        .to_owned();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock unavailable")?
        .as_nanos();
    let id = format!(
        "source-{timestamp}-{}",
        state.next.fetch_add(1, Ordering::Relaxed)
    );
    let mut slot = state
        .sources
        .lock()
        .map_err(|_| "Source state unavailable")?;
    load_sources(&app, &mut slot)?;
    let sources = slot.as_mut().ok_or("Source state unavailable")?;
    sources.insert(id.clone(), (agent.clone(), canonical));
    if let Err(error) = save_sources(&app, sources) {
        sources.remove(&id);
        return Err(error);
    }
    Ok(Some(UsageSource { id, agent, name }))
}

// Always reap the sidecar, including failures while setting up pipes.
struct SidecarChild(std::process::Child);

impl Drop for SidecarChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn execute(
    app: AppHandle,
    source: PathBuf,
    agent: String,
    force: bool,
    offset: usize,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("Scan cancelled".into());
    }
    let source = safe_source(&source, &agent)?;
    // NEOVERENÉ: Windows resource resolution requires installed-app testing.
    #[cfg(debug_assertions)]
    let sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../usage-service");
    #[cfg(not(debug_assertions))]
    let sidecar = app
        .path()
        .resource_dir()
        .map_err(|_| "Resources unavailable")?
        .join("usage-service");
    super::usage_integrity::verify(&sidecar)?;
    let runtime = sidecar.join(if cfg!(windows) { "node.exe" } else { "node" });
    let cache_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Data directory unavailable")?
        .join("usage");
    std::fs::create_dir_all(&cache_dir).map_err(|_| "Cache unavailable")?;
    let request = json!({"version":1,"requestId":"scan","method":"scan","params":{"agent":agent,"path":source,"cachePath":cache_dir.join("cache.sqlite"),"force":force,"offset":offset,"limit":500}});
    let mut command = Command::new(runtime);
    command
        .arg(sidecar.join("main.cjs"))
        .current_dir(&sidecar)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    let mut child = SidecarChild(command.spawn().map_err(|_| "Usage sidecar unavailable")?);
    let mut input = child.0.stdin.take().ok_or("Sidecar input unavailable")?;
    if writeln!(input, "{request}").is_err() {
        let _ = child.0.kill();
        let _ = child.0.wait();
        return Err("Sidecar input failed".into());
    }
    drop(input);
    let output = child.0.stdout.take().ok_or("Sidecar output unavailable")?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = child.0.kill();
            let _ = child.0.wait();
            return Err("Scan cancelled".into());
        }
        if let Some(status) = child.0.try_wait().map_err(|_| "Sidecar failed")? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.0.kill();
            let _ = child.0.wait();
            return Err("Sidecar timed out".into());
        }
        thread::sleep(Duration::from_millis(25));
    };
    if cancelled.load(Ordering::Acquire) {
        return Err("Scan cancelled".into());
    }
    let bytes = reader
        .join()
        .map_err(|_| "Sidecar output failed")?
        .map_err(|_| "Sidecar output failed")?;
    if !status.success() || bytes.len() > 8 * 1024 * 1024 {
        return Err("Sidecar output invalid".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Sidecar output invalid".into())
}

#[tauri::command]
pub async fn usage_scan(
    app: AppHandle,
    state: State<'_, UsageState>,
    id: String,
    force: bool,
    offset: Option<usize>,
) -> Result<Value, String> {
    let (agent, source) = {
        let mut slot = state
            .sources
            .lock()
            .map_err(|_| "Source state unavailable")?;
        load_sources(&app, &mut slot)?;
        slot.as_ref()
            .and_then(|sources| sources.get(&id))
            .cloned()
            .ok_or("Source not approved")?
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.active.lock().map_err(|_| "Scan state unavailable")?;
        if active.len() >= 2 || active.contains_key(&id) {
            return Err("Scan already active or limit reached".into());
        }
        active.insert(id.clone(), cancelled.clone());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        execute(app, source, agent, force, offset.unwrap_or(0), cancelled)
    })
    .await
    .map_err(|_| "Scan failed");
    state
        .active
        .lock()
        .map_err(|_| "Scan state unavailable")?
        .remove(&id);
    result?
}

#[tauri::command]
pub fn usage_cancel_scan(state: State<'_, UsageState>, id: String) -> Result<bool, String> {
    let active = state.active.lock().map_err(|_| "Scan state unavailable")?;
    if let Some(cancelled) = active.get(&id) {
        cancelled.store(true, Ordering::Release);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::safe_source;
    use std::path::Path;

    #[test]
    fn denies_sensitive_names_before_reading_files() {
        assert!(safe_source(Path::new("auth.jsonl"), "codex").is_err());
        assert!(safe_source(Path::new("credentials/usage.jsonl"), "codex").is_err());
        assert!(safe_source(Path::new("usage.jsonl"), "unknown").is_err());
    }
}
