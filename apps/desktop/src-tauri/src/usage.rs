mod discovery;
mod snapshot;

use discovery::{covers, discover, AUTO_CODEX, AUTO_IDS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
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
    sources: Mutex<Option<SourceSettings>>,
    next: AtomicU64,
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSource {
    id: String,
    agent: String,
    name: String,
    automatic: bool,
    enabled: bool,
    covered_by: Option<String>,
}

type SourceMap = HashMap<String, (String, PathBuf)>;

#[derive(Default, Deserialize, Serialize)]
struct SourceSettings {
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    disabled_automatic: BTreeSet<String>,
    #[serde(flatten)]
    manual: SourceMap,
}

fn usage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Data directory unavailable")?
        .join("usage"))
}

fn source_list_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(usage_dir(app)?.join("sources.json"))
}

fn load_sources(app: &AppHandle, slot: &mut Option<SourceSettings>) -> Result<(), String> {
    if slot.is_some() {
        return Ok(());
    }
    *slot = Some(read_source_settings(&source_list_path(app)?)?);
    Ok(())
}

fn read_source_settings(path: &Path) -> Result<SourceSettings, String> {
    let sources = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err("Source list invalid".into());
        }
        Ok(meta) if meta.len() > 1024 * 1024 => return Err("Source list too large".into()),
        Ok(_) => {
            let bytes = std::fs::read(path).map_err(|_| "Source list unavailable")?;
            serde_json::from_slice(&bytes).map_err(|_| "Source list invalid")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => SourceSettings::default(),
        Err(_) => return Err("Source list unavailable".into()),
    };
    Ok(sources)
}

fn save_sources(app: &AppHandle, sources: &SourceSettings) -> Result<(), String> {
    write_source_settings(&source_list_path(app)?, sources)
}

fn write_source_settings(path: &Path, sources: &SourceSettings) -> Result<(), String> {
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
pub async fn usage_list_sources(app: AppHandle) -> Result<Vec<UsageSource>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let automatic = discover();
        let state = app.state::<UsageState>();
        let mut slot = state
            .sources
            .lock()
            .map_err(|_| "Source state unavailable")?;
        load_sources(&app, &mut slot)?;
        let settings = slot.as_ref().ok_or("Source state unavailable")?;
        let mut sources = list_sources(settings, automatic);
        let dir = usage_dir(&app)?;
        for id in AUTO_IDS {
            if !sources.iter().any(|source| source.id == id) && snapshot::path(&dir, id)?.is_file()
            {
                let agent = id.trim_start_matches("auto-");
                sources.push(source_info(
                    id.into(),
                    agent.into(),
                    Path::new("uložená história"),
                    true,
                    !settings.disabled_automatic.contains(id),
                ));
            }
        }
        Ok(sources)
    })
    .await
    .map_err(|_| "Source discovery failed")?
}

fn source_info(
    id: String,
    agent: String,
    path: &Path,
    automatic: bool,
    enabled: bool,
) -> UsageSource {
    UsageSource {
        id,
        agent,
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("source")
            .to_owned(),
        automatic,
        enabled,
        covered_by: None,
    }
}

fn list_sources(
    settings: &SourceSettings,
    automatic: Vec<discovery::AutomaticSource>,
) -> Vec<UsageSource> {
    let mut sources: Vec<_> = automatic
        .into_iter()
        .map(|source| {
            let info = source_info(
                source.id.into(),
                source.agent.into(),
                &source.path,
                true,
                !settings.disabled_automatic.contains(source.id),
            );
            (info, Some(source.path))
        })
        .chain(settings.manual.iter().map(|(id, (agent, path))| {
            (
                source_info(id.clone(), agent.clone(), path, false, true),
                safe_source(path, agent).ok(),
            )
        }))
        .collect();
    // Place wider directories first. A manually chosen custom Codex home may
    // cover additional logs, while discovery only covers its history subtrees.
    sources.sort_by(|(a, ap), (b, bp)| {
        let key = |info: &UsageSource, path: &Option<PathBuf>| {
            let depth = path
                .as_ref()
                .map_or(usize::MAX, |path| path.components().count());
            let restricted = info.id == AUTO_CODEX
                && path.as_ref().is_some_and(|p| {
                    !p.file_name()
                        .is_some_and(|name| name.eq_ignore_ascii_case(".codex"))
                });
            (depth, restricted, !info.automatic)
        };
        key(a, ap).cmp(&key(b, bp)).then_with(|| a.id.cmp(&b.id))
    });
    for index in 0..sources.len() {
        let (previous, current) = sources.split_at_mut(index);
        let (info, path) = &mut current[0];
        if let Some(path) = path.as_ref().filter(|_| info.enabled) {
            info.covered_by = previous.iter().find_map(|(candidate, root)| {
                (candidate.enabled
                    && candidate.agent == info.agent
                    && root
                        .as_ref()
                        .is_some_and(|root| covers(root, path, candidate.id == AUTO_CODEX)))
                .then(|| candidate.id.clone())
            });
        }
    }
    sources.into_iter().map(|(source, _)| source).collect()
}

#[tauri::command]
pub fn usage_set_auto_source(
    app: AppHandle,
    state: State<'_, UsageState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    if !AUTO_IDS.contains(&id.as_str()) {
        return Err("Unknown automatic source".into());
    }
    let mut slot = state
        .sources
        .lock()
        .map_err(|_| "Source state unavailable")?;
    load_sources(&app, &mut slot)?;
    let sources = slot.as_mut().ok_or("Source state unavailable")?;
    set_auto_source(sources, &id, enabled, |sources| save_sources(&app, sources))
}

fn set_auto_source(
    sources: &mut SourceSettings,
    id: &str,
    enabled: bool,
    save: impl FnOnce(&SourceSettings) -> Result<(), String>,
) -> Result<(), String> {
    let changed = if enabled {
        sources.disabled_automatic.remove(id)
    } else {
        sources.disabled_automatic.insert(id.into())
    };
    if changed {
        if let Err(error) = save(sources) {
            if enabled {
                sources.disabled_automatic.insert(id.into());
            } else {
                sources.disabled_automatic.remove(id);
            }
            return Err(error);
        }
    }
    Ok(())
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
    let removed = sources.manual.remove(&id).ok_or("Source not approved")?;
    if let Err(error) = save_sources(&app, sources) {
        sources.manual.insert(id, removed);
        return Err(error);
    }
    if let Ok(path) = usage_dir(&app).and_then(|dir| snapshot::path(&dir, &id)) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

fn safe_source(path: &Path, agent: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Source must use an absolute path".into());
    }
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
    }
    for component in path.ancestors() {
        let metadata = std::fs::symlink_metadata(component).map_err(|_| "Source unavailable")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Linked source denied".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("Linked source denied".into());
        }
    }
    let metadata = std::fs::metadata(path).map_err(|_| "Source unavailable")?;
    if metadata.is_dir() {
        if agent != "codex"
            && !(agent == "grok-build"
                && path
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("sessions")))
        {
            return Err("Unsupported history folder".into());
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
    let info = source_info(id.clone(), agent.clone(), &canonical, false, true);
    sources.manual.insert(id.clone(), (agent, canonical));
    if let Err(error) = save_sources(&app, sources) {
        sources.manual.remove(&id);
        return Err(error);
    }
    Ok(Some(info))
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
    codex_home: bool,
    cancelled: Arc<AtomicBool>,
) -> Result<snapshot::Snapshot, String> {
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
    let cache_dir = usage_dir(&app)?;
    std::fs::create_dir_all(&cache_dir).map_err(|_| "Cache unavailable")?;
    let request = json!({"version":1,"requestId":"scan","method":"scan","params":{"agent":agent,"path":source,"cachePath":cache_dir.join("cache-v2.sqlite"),"force":force,"full":true,"codexHome":codex_home}});
    let mut command = Command::new(runtime);
    command
        .arg(sidecar.join("main.cjs"))
        .current_dir(&sidecar)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
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
            .take(snapshot::MAX_BYTES + 1)
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
    if !status.success() || bytes.len() as u64 > snapshot::MAX_BYTES {
        return Err("Sidecar output invalid".into());
    }
    let response = serde_json::from_slice(&bytes).map_err(|_| "Sidecar output invalid")?;
    snapshot::Snapshot::from_sidecar(response)
}

#[tauri::command]
pub async fn usage_scan(
    app: AppHandle,
    state: State<'_, UsageState>,
    id: String,
    force: bool,
    offset: Option<usize>,
    saved: Option<bool>,
) -> Result<Option<Value>, String> {
    let automatic = AUTO_IDS.contains(&id.as_str());
    let manual = {
        let mut slot = state
            .sources
            .lock()
            .map_err(|_| "Source state unavailable")?;
        load_sources(&app, &mut slot)?;
        let sources = slot.as_ref().ok_or("Source state unavailable")?;
        if automatic {
            if sources.disabled_automatic.contains(&id) {
                return Err("Automatic source is disabled".into());
            }
            None
        } else {
            Some(
                sources
                    .manual
                    .get(&id)
                    .cloned()
                    .ok_or("Source not approved")?,
            )
        }
    };
    let path = snapshot::path(&usage_dir(&app)?, &id)?;
    let offset = offset.unwrap_or(0);
    if saved == Some(true) || offset != 0 {
        return tauri::async_runtime::spawn_blocking(move || {
            Ok(snapshot::read(&path)?.map(|value| value.page(offset, false)))
        })
        .await
        .map_err(|_| "Saved Usage unavailable")?;
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.active.lock().map_err(|_| "Scan state unavailable")?;
        if active.len() >= 2 || active.contains_key(&id) {
            return Err("Scan already active or limit reached".into());
        }
        active.insert(id.clone(), cancelled.clone());
    }
    let codex_home = id == AUTO_CODEX;
    let source_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (agent, source) = manual
            .or_else(|| {
                discover()
                    .into_iter()
                    .find(|source| source.id == source_id)
                    .map(|source| (source.agent.to_owned(), source.path))
            })
            .ok_or("Source unavailable")?;
        let fresh = execute(app, source, agent, force, codex_home, cancelled)?;
        if let Ok(Some(previous)) = snapshot::read(&path) {
            if fresh.keeps_previous(&previous) {
                return Ok(Some(previous.page(0, true)));
            }
        }
        snapshot::write(&path, &fresh)?;
        Ok(Some(fresh.page(0, false)))
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
    use super::*;

    #[test]
    fn denies_sensitive_names_before_reading_files() {
        let home = std::env::temp_dir();
        assert_eq!(
            safe_source(&home.join("auth.jsonl"), "codex").unwrap_err(),
            "Sensitive source denied"
        );
        // The final filename itself can look like a valid transcript.
        assert_eq!(
            safe_source(&home.join("credentials").join("usage.jsonl"), "codex").unwrap_err(),
            "Sensitive source denied"
        );
        assert!(safe_source(Path::new("usage.jsonl"), "unknown").is_err());
    }

    #[test]
    fn clean_profile_lists_automatic_history_and_persists_a_disable_with_manual_overlap() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lab-m4-discovery-{nonce:x}"));
        let home = root.join("custom-home");
        let sessions = home.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let manual = sessions.join("rollout.jsonl");
        std::fs::write(&manual, "").unwrap();
        let path = root.join("sources.json");
        let auto = || {
            vec![discovery::AutomaticSource {
                id: AUTO_CODEX,
                agent: "codex",
                path: std::fs::canonicalize(&home).unwrap(),
            }]
        };
        let settings = read_source_settings(&path).unwrap();
        let clean = list_sources(&settings, auto());
        assert_eq!(clean.len(), 1);
        assert!(clean[0].automatic && clean[0].enabled);

        // The legacy on-disk format is a flat map of picker IDs.
        let legacy = json!({ "source-manual": ["codex", manual] });
        std::fs::write(&path, legacy.to_string()).unwrap();
        let mut settings = read_source_settings(&path).unwrap();
        let covered = list_sources(&settings, auto());
        assert_eq!(covered[1].covered_by.as_deref(), Some(AUTO_CODEX));
        set_auto_source(&mut settings, AUTO_CODEX, false, |s| {
            write_source_settings(&path, s)
        })
        .unwrap();

        let restarted = list_sources(&read_source_settings(&path).unwrap(), auto());
        assert!(!restarted[0].enabled);
        assert!(restarted[1].enabled);
        assert!(restarted[1].covered_by.is_none());
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(manual).unwrap();
        std::fs::remove_dir(sessions).unwrap();
        std::fs::remove_dir(home).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
