use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct UsageState {
    sources: Mutex<HashMap<String, (String, PathBuf)>>,
    next: AtomicU64,
}
#[derive(Serialize)]
pub struct UsageSource {
    id: String,
    agent: String,
    name: String,
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
    let selected = tauri::async_runtime::spawn_blocking(move || {
        if choose_folder {
            app.dialog().file().blocking_pick_folder()
        } else {
            app.dialog().file().blocking_pick_file()
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
    let id = format!("source-{}", state.next.fetch_add(1, Ordering::Relaxed));
    state
        .sources
        .lock()
        .map_err(|_| "Source state unavailable")?
        .insert(id.clone(), (agent.clone(), canonical));
    Ok(Some(UsageSource { id, agent, name }))
}

fn execute(
    app: AppHandle,
    source: PathBuf,
    agent: String,
    force: bool,
    offset: usize,
) -> Result<Value, String> {
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
    let mut child = command.spawn().map_err(|_| "Usage sidecar unavailable")?;
    let mut input = child.stdin.take().ok_or("Sidecar input unavailable")?;
    writeln!(input, "{request}").map_err(|_| "Sidecar input failed")?;
    drop(input);
    let output = child.stdout.take().ok_or("Sidecar output unavailable")?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| "Sidecar failed")? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Sidecar timed out".into());
        }
        thread::sleep(Duration::from_millis(25));
    };
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
    let (agent, source) = state
        .sources
        .lock()
        .map_err(|_| "Source state unavailable")?
        .get(&id)
        .cloned()
        .ok_or("Source not approved")?;
    tauri::async_runtime::spawn_blocking(move || {
        execute(app, source, agent, force, offset.unwrap_or(0))
    })
    .await
    .map_err(|_| "Scan failed")?
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
