mod chat;
mod pty_input;
mod usage;
mod usage_integrity;
#[cfg(windows)]
mod windows_pty;
#[cfg(windows)]
mod windows_pty_host;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
#[cfg(windows)]
use std::time::Instant;

#[cfg(not(windows))]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

struct PtyInstance {
    input: pty_input::PtyInput,
    #[cfg(not(windows))]
    child: Box<dyn portable_pty::Child + Send + Sync>,
    #[cfg(windows)]
    master: windows_pty_host::WindowsPtyHost,
    #[cfg(not(windows))]
    master: Box<dyn portable_pty::MasterPty + Send>,
    kill_flag: Arc<AtomicBool>,
    reader: thread::JoinHandle<()>,
}

impl PtyInstance {
    #[cfg(windows)]
    fn close(mut self) -> Result<(), String> {
        let deadline = Instant::now() + windows_pty_host::CLEANUP_LIMIT;
        self.begin_close();
        let stopped = self.master.stop_by(deadline);
        self.finish_close(deadline, stopped)
    }

    #[cfg(windows)]
    fn begin_close(&mut self) {
        self.kill_flag.store(true, Ordering::Release);
        self.reader.thread().unpark();
        self.input.begin_close();
        // stop_by checks the stop again and forces the job if needed.
        let _ = self.master.request_stop();
    }

    #[cfg(windows)]
    fn finish_close(self, deadline: Instant, stopped: std::io::Result<()>) -> Result<(), String> {
        let host = match stopped {
            Ok(()) => self.master.wait_closed_by(deadline),
            Err(error) => {
                // The last job handle still triggers kill-on-close.
                drop(self.master);
                Err(error)
            }
        }
        .map_err(|error| format!("PowerShell cleanup failed: {error}"));
        let input = self.input.finish_by(deadline);
        let reader = pty_input::join_worker_by(self.reader, deadline, "PTY output reader");
        host.and(input).and(reader)?;
        if Instant::now() > deadline {
            return Err("Terminal cleanup exceeded its shared deadline".into());
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn close(self) -> Result<(), String> {
        let Self {
            input,
            master,
            child,
            kill_flag,
            reader,
        } = self;
        kill_flag.store(true, Ordering::Release);
        let child_result = {
            let mut child = child;
            let result = match child.try_wait() {
                Ok(Some(_)) => Ok(()),
                _ => child.kill().and_then(|()| child.wait().map(|_| ())),
            };
            drop(input);
            result
        };
        drop(master);
        reader.join().map_err(|_| "PTY output reader panicked")?;
        child_result.map_err(|error| format!("PowerShell cleanup failed: {error}"))
    }
}

#[derive(Default)]
struct PtyRegistry {
    closing: bool,
    instances: HashMap<String, PtyInstance>,
}

#[derive(Default)]
struct AppState {
    pty: Mutex<PtyRegistry>,
    agent_hook_url: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: String,
    data: String,
}

fn publish_pty_event<T: Serialize + Clone + Send + 'static>(
    app: &AppHandle,
    _closing: &Arc<AtomicBool>,
    event: &'static str,
    payload: T,
) {
    #[cfg(windows)]
    {
        // The reader must not wait for WebView or listener locks while the
        // main thread is closing the window and joining it.
        let emitter = app.clone();
        let closing = _closing.clone();
        let _ = app.run_on_main_thread(move || {
            if !closing.load(Ordering::Acquire) {
                let _ = emitter.emit(event, payload);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = app.emit(event, payload);
}

// A PTY read can end in the middle of a UTF-8 character. Keep those bytes
// until the next read so terminal output does not gain replacement glyphs.
#[derive(Default)]
struct Utf8OutputDecoder {
    pending: Vec<u8>,
}

impl Utf8OutputDecoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();

        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    self.pending.drain(..valid);
                    if let Some(invalid_len) = error.error_len() {
                        output.push('\u{fffd}');
                        self.pending.drain(..invalid_len);
                    } else {
                        break;
                    }
                }
            }
        }

        output
    }

    fn finish(self) -> String {
        String::from_utf8_lossy(&self.pending).into_owned()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentHookFinished {
    run_id: String,
    agent: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
struct AgentChatCompletionResponse {
    status: u16,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
struct AgentAudioTranscriptionResponse {
    status: u16,
    body: String,
}

fn kill_instance(id: &str, state: &AppState) -> Result<bool, String> {
    let removed = state
        .pty
        .lock()
        .map_err(|_| "PTY registry unavailable")?
        .instances
        .remove(id);
    let Some(instance) = removed else {
        return Ok(false);
    };
    instance.close()?;
    Ok(true)
}

fn kill_all(state: &AppState) {
    let instances: Vec<PtyInstance> = if let Ok(mut registry) = state.pty.lock() {
        registry.closing = true;
        registry
            .instances
            .drain()
            .map(|(_, instance)| instance)
            .collect()
    } else {
        return;
    };

    #[cfg(windows)]
    {
        let deadline = Instant::now() + windows_pty_host::CLEANUP_LIMIT;
        let mut instances = instances;
        for instance in &mut instances {
            instance.begin_close();
        }
        // Send all forced terminations before waiting for any job to empty.
        let stopped: Vec<_> = instances
            .into_iter()
            .map(|instance| {
                let result = instance.master.stop_by(deadline);
                (instance, result)
            })
            .collect();
        for (instance, result) in stopped {
            if let Err(error) = instance.finish_close(deadline, result) {
                eprintln!("{error}");
            }
        }
    }
    #[cfg(not(windows))]
    {
        for instance in instances {
            if let Err(error) = instance.close() {
                eprintln!("{error}");
            }
        }
    }
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("pty-{:x}", nanos)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                output.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = &input[i + 1..i + 3];
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    output.push(value);
                    i += 3;
                } else {
                    output.push(bytes[i]);
                    i += 1;
                }
            }
            value => {
                output.push(value);
                i += 1;
            }
        }
    }

    String::from_utf8_lossy(&output).into_owned()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|part| {
        let (name, value) = part.split_once('=')?;
        if percent_decode(name) == key {
            Some(percent_decode(value))
        } else {
            None
        }
    })
}

fn handle_agent_hook_request(mut stream: TcpStream, app: &AppHandle) {
    let mut buffer = [0u8; 8192];
    let read = stream.read(&mut buffer).unwrap_or(0);
    let request = String::from_utf8_lossy(&buffer[..read]);
    let mut accepted = false;

    if let Some(request_line) = request.lines().next() {
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default();
        let target = parts.next().unwrap_or_default();
        let (path, query) = target.split_once('?').unwrap_or((target, ""));

        if method == "POST" && path == "/agent-finished" {
            if let Some(run_id) = query_value(query, "runId").filter(|value| !value.is_empty()) {
                let payload = AgentHookFinished {
                    run_id,
                    agent: query_value(query, "agent").filter(|value| !value.is_empty()),
                };
                accepted = app.emit("agent-finished", payload).is_ok();
            }
        }
    }

    let (status, body) = if accepted {
        ("200 OK", "{}")
    } else {
        ("400 Bad Request", r#"{"error":"bad request"}"#)
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn start_agent_hook_server(app: AppHandle) -> Result<String, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("hook bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("hook local addr failed: {e}"))?
        .port();
    let url = format!("http://127.0.0.1:{port}/agent-finished");

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle_agent_hook_request(stream, &app);
        }
    });

    Ok(url)
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "user home directory not found".to_string())
}

#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
fn agent_settings_path(home: &Path) -> PathBuf {
    home.join(".lab-m4").join("agent.json")
}

fn app_settings_path(home: &Path) -> PathBuf {
    home.join(".lab-m4").join("settings.json")
}

fn default_agent_settings() -> Value {
    json!({
        "provider": "openrouter",
        "model": "anthropic/claude-3.5-sonnet",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "",
        "dictationStyle": "clean"
    })
}

fn default_app_settings() -> Value {
    json!({
        "version": 1,
        "appearance": {
            "theme": "wraith"
        },
        "terminal": {
            "fontFamily": "Cascadia Code, Consolas, Courier New, monospace",
            "fontSize": 13,
            "colorMode": "theme",
            "colors": {
                "foreground": "#e1e9e9",
                "background": "#0d1216",
                "cursor": "#78d8bd",
                "selectionBackground": "#285348"
            }
        },
        "ai": default_agent_settings(),
        "general": {
            "confirmClosePane": true,
            "confirmCloseSession": true,
            "sidebarCollapsed": false,
            "sidebarWidth": 220,
            "window": {
                "width": 900,
                "height": 700,
                "x": null,
                "y": null
            }
        }
    })
}

/// Deep-merge `overlay` into `base` for objects; non-objects are replaced.
fn merge_json(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            for (key, val) in overlay_map {
                match base_map.get_mut(key) {
                    Some(existing) => merge_json(existing, val),
                    None => {
                        base_map.insert(key.clone(), val.clone());
                    }
                }
            }
        }
        (base_slot, overlay_val) => {
            *base_slot = overlay_val.clone();
        }
    }
}

fn load_app_settings_value() -> Result<Value, String> {
    let home = user_home()?;
    let path = app_settings_path(&home);
    let mut settings = default_app_settings();

    if path.exists() {
        let file = load_json_object(&path)?;
        merge_json(&mut settings, &file);
    }

    Ok(settings)
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {} failed: {e}", parent.display()))?;
    }
    let json =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize JSON failed: {e}"))?;
    std::fs::write(path, format!("{json}\n"))
        .map_err(|e| format!("write {} failed: {e}", path.display()))
}

fn load_json_object(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }

    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("read {} failed: {e}", path.display()))?;
    let value: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("parse {} failed: {e}", path.display()))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{} must contain a JSON object", path.display()))
    }
}

#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
fn ensure_agent_hook_script(home: &Path) -> Result<String, String> {
    let script_dir = home.join(".wraith");
    std::fs::create_dir_all(&script_dir)
        .map_err(|e| format!("create {} failed: {e}", script_dir.display()))?;

    let script_path = script_dir.join("wraith-agent-finished.ps1");
    let script = r#"$hookUrl = [Environment]::GetEnvironmentVariable('WRAITH_AGENT_HOOK_URL')
$runId = [Environment]::GetEnvironmentVariable('WRAITH_AGENT_RUN_ID')

if ([string]::IsNullOrWhiteSpace($hookUrl) -or [string]::IsNullOrWhiteSpace($runId)) {
  exit 0
}

try {
  $uriBuilder = [System.UriBuilder]::new($hookUrl)
  $query = 'runId=' + [System.Uri]::EscapeDataString($runId)
  $label = [Environment]::GetEnvironmentVariable('WRAITH_AGENT_LABEL')
  if (-not [string]::IsNullOrWhiteSpace($label)) {
    $query += '&agent=' + [System.Uri]::EscapeDataString($label)
  }
  $uriBuilder.Query = $query
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uriBuilder.Uri.AbsoluteUri -TimeoutSec 2 | Out-Null
} catch {
}
"#;
    std::fs::write(&script_path, script)
        .map_err(|e| format!("write {} failed: {e}", script_path.display()))?;

    let escaped_path = script_path.display().to_string().replace('"', "\\\"");
    Ok(format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{escaped_path}\""
    ))
}

#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
fn ensure_stop_hook_json(path: &Path, command: &str) -> Result<(), String> {
    let mut root = load_json_object(path)?;
    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))?;
    let hooks = root_obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }

    let hooks_obj = hooks
        .as_object_mut()
        .ok_or_else(|| "hooks must be a JSON object".to_string())?;
    let stop = hooks_obj.entry("Stop").or_insert_with(|| json!([]));
    if !stop.is_array() {
        *stop = json!([]);
    }

    let stop_array = stop
        .as_array_mut()
        .ok_or_else(|| "Stop hooks must be a JSON array".to_string())?;
    stop_array.retain(|entry| {
        let entry = entry.to_string().to_ascii_lowercase();
        !entry.contains("wraith_agent_hook_url")
            && !entry.contains("wraith-agent-finished.ps1")
            && !entry.contains("wraith agent completion notification")
    });
    stop_array.push(json!({
        "hooks": [
            {
                "type": "command",
                "command": command,
                "timeout": 5
            }
        ]
    }));

    write_json_pretty(path, &root)
}

#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
fn ensure_grok_hook(home: &Path, command: &str) -> Result<(), String> {
    let path = home
        .join(".grok")
        .join("hooks")
        .join("wraith-finished.json");
    let value = json!({
        "description": "Wraith agent completion notification",
        "hooks": {
            "Stop": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": command,
                            "timeout": 5
                        }
                    ]
                }
            ]
        }
    });
    write_json_pretty(&path, &value)
}

#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
fn ensure_opencode_plugin(home: &Path) -> Result<(), String> {
    let plugin_dir = home.join(".config").join("opencode").join("plugins");
    std::fs::create_dir_all(&plugin_dir)
        .map_err(|e| format!("create {} failed: {e}", plugin_dir.display()))?;

    let path = plugin_dir.join("wraith-notify.js");
    let source = r#"export const WraithNotifyPlugin = async () => {
  let lastRunId = "";
  let lastAt = 0;

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const url = process.env.WRAITH_AGENT_HOOK_URL;
      const runId = process.env.WRAITH_AGENT_RUN_ID;
      const agent = process.env.WRAITH_AGENT_LABEL || "opencode";
      if (!url || !runId) return;

      const now = Date.now();
      if (runId === lastRunId && now - lastAt < 1000) return;
      lastRunId = runId;
      lastAt = now;

      const target = new URL(url);
      target.searchParams.set("runId", runId);
      target.searchParams.set("agent", agent);
      await fetch(target, { method: "POST" }).catch(() => undefined);
    },
  };
};
"#;

    std::fs::write(&path, source).map_err(|e| format!("write {} failed: {e}", path.display()))
}

#[tauri::command]
fn agent_hook_url(state: State<'_, AppState>) -> Result<String, String> {
    state
        .agent_hook_url
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| "agent hook server not ready".to_string())
}

#[tauri::command]
fn load_app_settings() -> Result<Value, String> {
    load_app_settings_value()
}

#[tauri::command]
fn save_app_settings(state: Value) -> Result<(), String> {
    let home = user_home()?;
    let path = app_settings_path(&home);
    // Merge onto defaults so partial saves never drop unknown/missing keys.
    let mut merged = default_app_settings();
    merge_json(&mut merged, &state);
    if let Some(ai) = merged.get_mut("ai").and_then(Value::as_object_mut) {
        ai.remove("apiKey");
    }
    write_json_pretty(&path, &merged)
}

/// Compatibility: load AI section from unified settings.json.
#[tauri::command]
#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
fn load_agent_settings() -> Result<Value, String> {
    let settings = load_app_settings_value()?;
    Ok(settings
        .get("ai")
        .cloned()
        .unwrap_or_else(default_agent_settings))
}

/// Compatibility: write AI section into unified settings.json.
#[tauri::command]
#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
fn save_agent_settings(state: Value) -> Result<(), String> {
    let home = user_home()?;
    let path = app_settings_path(&home);
    let mut settings = load_app_settings_value()?;
    if let Some(ai) = settings.get_mut("ai") {
        // Replace AI section keys with provided state (merged onto defaults).
        let mut ai_defaults = default_agent_settings();
        merge_json(&mut ai_defaults, &state);
        *ai = ai_defaults;
    } else if let Some(obj) = settings.as_object_mut() {
        let mut ai_defaults = default_agent_settings();
        merge_json(&mut ai_defaults, &state);
        obj.insert("ai".to_string(), ai_defaults);
    }
    write_json_pretty(&path, &settings)
}

#[tauri::command]
#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
async fn agent_chat_completion(
    url: String,
    headers: HashMap<String, String>,
    body: Value,
) -> Result<AgentChatCompletionResponse, String> {
    let (status, body) = post_json(url, headers, body).await?;
    Ok(AgentChatCompletionResponse { status, body })
}

#[tauri::command]
#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
async fn agent_audio_transcription(
    url: String,
    headers: HashMap<String, String>,
    body: Value,
) -> Result<AgentAudioTranscriptionResponse, String> {
    let (status, body) = post_json(url, headers, body).await?;
    Ok(AgentAudioTranscriptionResponse { status, body })
}

#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
async fn post_json(
    url: String,
    headers: HashMap<String, String>,
    body: Value,
) -> Result<(u16, String), String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

    let target = reqwest::Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    if target.scheme() != "https" && target.scheme() != "http" {
        return Err("agent URL must use http or https".to_string());
    }

    let mut header_map = HeaderMap::new();
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("invalid header {name}: {e}"))?;
        let header_value = HeaderValue::from_str(&value)
            .map_err(|e| format!("invalid header value for {name}: {e}"))?;
        header_map.insert(header_name, header_value);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP client failed: {e}"))?;
    let response = client
        .post(target)
        .headers(header_map)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| format!("read response failed: {e}"))?;

    Ok((status, body))
}

#[tauri::command]
#[allow(dead_code)] // Preserved legacy implementation; disabled in Lab-M4.
fn ensure_agent_hooks() -> Result<(), String> {
    let home = user_home()?;
    let command = ensure_agent_hook_script(&home)?;

    ensure_stop_hook_json(&home.join(".codex").join("hooks.json"), &command)?;
    ensure_stop_hook_json(&home.join(".claude").join("settings.json"), &command)?;
    ensure_grok_hook(&home, &command)?;
    ensure_opencode_plugin(&home)?;

    Ok(())
}

#[tauri::command]
fn spawn_powershell(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: Option<String>,
) -> Result<String, String> {
    const MAX_SESSIONS: usize = 32;
    {
        let registry = state.pty.lock().map_err(|_| "PTY registry unavailable")?;
        if registry.closing {
            return Err("Terminal is closing".into());
        }
        if registry.instances.len() >= MAX_SESSIONS {
            return Err("Terminal session limit reached".into());
        }
    }
    #[cfg(windows)]
    let (master, reader, writer) = windows_pty_host::WindowsPtyHost::start(80, 24, cwd.as_deref())
        .map_err(|error| format!("openpty failed: {error}"))?;
    #[cfg(not(windows))]
    let (master, slave, reader, writer) = {
        let pty_pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;
        let reader = pty_pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader failed: {e}"))?;
        let writer = pty_pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer failed: {e}"))?;
        (pty_pair.master, pty_pair.slave, reader, writer)
    };
    let input = match pty_input::PtyInput::start(writer) {
        Ok(input) => input,
        Err(error) => {
            #[cfg(windows)]
            let _ = master.close_by(Instant::now() + windows_pty_host::CLEANUP_LIMIT);
            return Err(format!("start input worker failed: {error}"));
        }
    };

    let id = new_id();
    let kill_flag = Arc::new(AtomicBool::new(false));
    let kill_flag_reader = kill_flag.clone();
    let app_handle = app.clone();
    let id_for_thread = id.clone();

    let reader = thread::Builder::new()
        .name("pty-output".into())
        .spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            let mut decoder = Utf8OutputDecoder::default();
            loop {
                #[cfg(windows)]
                if kill_flag_reader.load(Ordering::Acquire) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if kill_flag_reader.load(Ordering::Acquire) {
                            continue;
                        }
                        let data = decoder.push(&buf[..n]);
                        if data.is_empty() {
                            continue;
                        }
                        let payload = PtyOutput {
                            id: id_for_thread.clone(),
                            data,
                        };
                        publish_pty_event(&app_handle, &kill_flag_reader, "pty-output", payload);
                    }
                    #[cfg(windows)]
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::park_timeout(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
            if kill_flag_reader.load(Ordering::Acquire) {
                return;
            }
            let remaining = decoder.finish();
            if !remaining.is_empty() {
                publish_pty_event(
                    &app_handle,
                    &kill_flag_reader,
                    "pty-output",
                    PtyOutput {
                        id: id_for_thread.clone(),
                        data: remaining,
                    },
                );
            }
            publish_pty_event(&app_handle, &kill_flag_reader, "pty-exit", id_for_thread);
        });

    let reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            #[cfg(windows)]
            {
                let deadline = Instant::now() + windows_pty_host::CLEANUP_LIMIT;
                let mut input = input;
                input.begin_close();
                let _ = master.close_by(deadline);
                let _ = input.finish_by(deadline);
            }
            return Err(format!("start output reader failed: {error}"));
        }
    };

    #[cfg(not(windows))]
    let child = {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        if let Some(path) = cwd.as_deref().filter(|path| !path.trim().is_empty()) {
            cmd.cwd(path);
        }
        slave.spawn_command(cmd)
    };
    #[cfg(not(windows))]
    let child = match child {
        Ok(child) => child,
        Err(error) => {
            kill_flag.store(true, Ordering::Release);
            drop(input);
            drop(master);
            let _ = reader.join();
            return Err(format!("spawn failed: {error}"));
        }
    };

    let instance = PtyInstance {
        input,
        master,
        #[cfg(not(windows))]
        child,
        kill_flag,
        reader,
    };

    if let Ok(mut registry) = state.pty.lock() {
        if !registry.closing && registry.instances.len() < MAX_SESSIONS {
            registry.instances.insert(id.clone(), instance);
            return Ok(id);
        }
    }
    instance.close()?;
    Err("Cannot register another terminal session".into())
}

#[tauri::command]
async fn write_powershell(
    _app: AppHandle,
    id: String,
    input: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    #[cfg(feature = "webdriver")]
    let mut trace =
        json!({"id": id.clone(), "bytes": input.len(), "carriageReturn": input.ends_with('\r')});
    let completed = {
        let registry = state.pty.lock().map_err(|_| "PTY registry unavailable")?;
        registry
            .instances
            .get(&id)
            .ok_or("Terminal session is closed")?
            .input
            .enqueue(input)?
    };
    let result = completed
        .await
        .map_err(|_| "Terminal input was cancelled")?;
    #[cfg(feature = "webdriver")]
    {
        trace["ok"] = json!(result.is_ok());
        let _ = _app.emit("terminal-input-completed", trace);
    }
    result
}

#[tauri::command]
fn resize_powershell(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let slot = state
        .pty
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let instance = slot.instances.get(&id).ok_or("no such pty")?;
    #[cfg(windows)]
    {
        instance
            .master
            .resize(cols, rows)
            .map_err(|e| format!("resize failed: {e}"))
    }
    #[cfg(not(windows))]
    {
        instance
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))
    }
}

#[tauri::command]
fn kill_powershell(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if kill_instance(&id, &state)? {
        let _ = app.emit("pty-exit", id);
    }
    Ok(())
}

#[tauri::command]
fn list_powershell(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let slot = state
        .pty
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    Ok(slot.instances.keys().cloned().collect())
}

fn sessions_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("app data dir failed: {e}"))
        .map(|dir| dir.join("sessions.json"))
}

#[tauri::command]
fn load_sessions(app: AppHandle) -> Result<Option<Value>, String> {
    let path = sessions_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("read sessions failed: {e}"))?;
    let value: Value =
        serde_json::from_str(&contents).map_err(|e| format!("parse sessions failed: {e}"))?;
    Ok(Some(value))
}

#[tauri::command]
fn save_sessions(app: AppHandle, state: Value) -> Result<(), String> {
    let path = sessions_path(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "sessions path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create sessions dir failed: {e}"))?;

    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("serialize sessions failed: {e}"))?;
    let tmp_path = dir.join("sessions.json.tmp");
    std::fs::write(&tmp_path, json).map_err(|e| format!("write sessions failed: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("commit sessions failed: {e}"))?;
    Ok(())
}

/// Arguments passed through WebView2's API when a WebDriver session asked for automation.
///
/// `TAURI_WEBVIEW_AUTOMATION` is set by tauri-driver. wry treats that flag as a no-op on
/// Windows, and WebView2 150+ does not open a DevTools port from
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` alone. The port stays closed for a normal launch.
#[cfg_attr(not(feature = "webdriver"), allow(dead_code))]
pub(crate) fn automation_browser_args(
    webview_automation: Option<&str>,
    legacy_automation: Option<&str>,
    webview_arguments: Option<&str>,
) -> Option<String> {
    if !automation_requested(webview_automation, legacy_automation) {
        return None;
    }
    // Keep the driver's full switch list. WebView2 only honors it through the
    // API, and dropping `--enable-automation` leaves the debugging port closed.
    let mut args = webview_arguments.unwrap_or("").trim().to_string();
    if remote_debugging_port(&args).is_none() {
        if !args.is_empty() {
            args.push(' ');
        }
        args.push_str("--remote-debugging-port=0");
    }
    if !args.contains("--remote-allow-origins=") {
        args.push_str(" --remote-allow-origins=*");
    }
    Some(with_required_disabled_features(&args))
}

#[cfg_attr(not(feature = "webdriver"), allow(dead_code))]
fn with_required_disabled_features(args: &str) -> String {
    const REQUIRED: [&str; 3] = ["msWebOOUI", "msPdfOOUI", "msSmartScreenProtection"];
    let mut kept = Vec::new();
    let mut features = Vec::new();
    for token in args.split_whitespace() {
        if let Some(value) = token.strip_prefix("--disable-features=") {
            for feature in value.split(',').filter(|feature| !feature.is_empty()) {
                if !features.iter().any(|have: &String| have == feature) {
                    features.push(feature.to_string());
                }
            }
        } else {
            kept.push(token.to_string());
        }
    }
    for feature in REQUIRED {
        if !features.iter().any(|have| have == feature) {
            features.push(feature.to_string());
        }
    }
    if !features.is_empty() {
        kept.push(format!("--disable-features={}", features.join(",")));
    }
    kept.join(" ")
}

#[cfg_attr(not(feature = "webdriver"), allow(dead_code))]
pub(crate) fn automation_data_dir(
    webview_automation: Option<&str>,
    legacy_automation: Option<&str>,
    user_data_folder: Option<&str>,
) -> Option<PathBuf> {
    if !automation_requested(webview_automation, legacy_automation) {
        return None;
    }
    let raw = user_data_folder?.trim();
    let path = PathBuf::from(raw);
    if raw.is_empty() || !path.is_absolute() {
        return None;
    }
    Some(path)
}

#[cfg_attr(not(feature = "webdriver"), allow(dead_code))]
fn automation_requested(webview_automation: Option<&str>, legacy_automation: Option<&str>) -> bool {
    cfg!(feature = "webdriver")
        && (webview_automation == Some("true") || legacy_automation == Some("true"))
}

#[cfg_attr(not(feature = "webdriver"), allow(dead_code))]
fn remote_debugging_port(extra: &str) -> Option<&str> {
    extra.split_whitespace().find_map(|token| {
        let value = token
            .trim_matches('"')
            .strip_prefix("--remote-debugging-port=")?;
        if (1..=5).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit()) {
            Some(value)
        } else {
            None
        }
    })
}

fn open_configured_window(app: &tauri::App) -> Result<(), std::io::Error> {
    #[cfg(all(windows, not(feature = "webdriver")))]
    for name in [
        "TAURI_WEBVIEW_AUTOMATION",
        "TAURI_AUTOMATION",
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    ] {
        // WebView2 also reads arguments directly from the environment.
        std::env::remove_var(name);
    }
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| std::io::Error::other("Lab-M4 window config is missing"))?;
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    #[cfg(all(windows, feature = "webdriver"))]
    {
        let webview_automation = std::env::var("TAURI_WEBVIEW_AUTOMATION").ok();
        let legacy_automation = std::env::var("TAURI_AUTOMATION").ok();
        let webview_arguments = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok();
        if let Some(args) = automation_browser_args(
            webview_automation.as_deref(),
            legacy_automation.as_deref(),
            webview_arguments.as_deref(),
        ) {
            builder = builder.additional_browser_args(&args);
            // The loader appends the environment copy after the API arguments.
            // Keeping both lets the ignored copy win on the command line.
            std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        }
        if let Some(dir) = automation_data_dir(
            webview_automation.as_deref(),
            legacy_automation.as_deref(),
            std::env::var("WEBVIEW2_USER_DATA_FOLDER").ok().as_deref(),
        ) {
            builder = builder.data_directory(dir);
        }
    }
    builder
        .build()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    if let Some(code) = windows_pty_host::maybe_run() {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(chat::ChatState::default())
        .manage(usage::UsageState::default())
        .setup(|app| {
            let url =
                start_agent_hook_server(app.handle().clone()).map_err(std::io::Error::other)?;
            let state = app.state::<AppState>();
            if let Ok(mut slot) = state.agent_hook_url.lock() {
                *slot = Some(url);
            }
            open_configured_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_powershell,
            write_powershell,
            resize_powershell,
            kill_powershell,
            list_powershell,
            load_sessions,
            save_sessions,
            agent_hook_url,
            load_app_settings,
            save_app_settings,
            chat::chat_send,
            chat::chat_stop,
            chat::chat_reset,
            usage::usage_suggest_sources,
            usage::usage_list_sources,
            usage::usage_remove_source,
            usage::usage_select_source,
            usage::usage_scan,
            usage::usage_cancel_scan
        ])
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                if let Some(state) = window.app_handle().try_state::<chat::ChatState>() {
                    state.close();
                }
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    kill_all(&state);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{automation_browser_args, automation_data_dir, Utf8OutputDecoder};

    #[cfg(feature = "webdriver")]
    #[test]
    fn webdriver_port_is_enabled_only_for_an_automation_session() {
        assert!(automation_browser_args(None, None, None).is_none());
        assert!(automation_browser_args(Some("false"), Some("1"), None).is_none());
        let enabled = automation_browser_args(Some("true"), None, None).unwrap();
        assert!(enabled.contains("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
        assert!(enabled.contains("--remote-debugging-port=0"));
        assert!(enabled.contains("--remote-allow-origins=*"));
        let driver_port = automation_browser_args(
            None,
            Some("true"),
            Some("--disable-gpu --remote-debugging-port=9333"),
        )
        .unwrap();
        assert!(driver_port.contains("--remote-debugging-port=9333"));
        assert!(!driver_port.contains("--remote-debugging-port=0"));
        assert!(
            automation_browser_args(Some("true"), None, Some("--remote-debugging-port=nope"))
                .unwrap()
                .contains("--remote-debugging-port=0")
        );
        let driver = "--enable-automation --disable-features=IgnoreDuplicateNavs,Prewarm --remote-debugging-port=0 --test-type=webdriver";
        let kept = automation_browser_args(Some("true"), None, Some(driver)).unwrap();
        assert!(kept.contains("--enable-automation"));
        assert!(kept.contains("--test-type=webdriver"));
        assert_eq!(kept.matches("--disable-features=").count(), 1);
        assert!(kept.contains("IgnoreDuplicateNavs"));
        assert!(kept.contains("msWebOOUI"));
        assert_eq!(kept.matches("--remote-debugging-port=").count(), 1);
    }

    #[cfg(feature = "webdriver")]
    #[test]
    fn automation_profile_accepts_only_an_absolute_driver_folder() {
        let absolute = std::env::temp_dir();
        let text = absolute.to_str().expect("temp dir is unicode");
        assert_eq!(
            automation_data_dir(Some("true"), None, Some(text)).as_deref(),
            Some(absolute.as_path())
        );
        assert!(automation_data_dir(None, None, Some(text)).is_none());
        assert!(automation_data_dir(Some("true"), None, Some("relative\\profile")).is_none());
        assert!(automation_data_dir(Some("true"), None, Some("  ")).is_none());
    }

    #[cfg(not(feature = "webdriver"))]
    #[test]
    fn production_ignores_automation_environment_values() {
        assert!(automation_browser_args(
            Some("true"),
            Some("true"),
            Some("--remote-debugging-port=9333")
        )
        .is_none());
        assert!(automation_data_dir(Some("true"), Some("true"), Some("C:\\test")).is_none());
    }

    #[test]
    fn pty_text_preserves_characters_split_across_reads() {
        let mut decoder = Utf8OutputDecoder::default();
        assert_eq!(decoder.push(b"A\xf0\x9f"), "A");
        assert_eq!(decoder.push(b"\x91"), "");
        assert_eq!(decoder.push(b"\x8b B"), "👋 B");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn pty_text_replaces_only_invalid_bytes() {
        let mut decoder = Utf8OutputDecoder::default();
        assert_eq!(decoder.push(b"ok\xff!\xe2"), "ok�!");
        assert_eq!(decoder.push(b"\x82\xac"), "€");
        assert_eq!(decoder.finish(), "");
    }
}
