mod pty_input;
mod usage;
mod usage_integrity;
#[cfg(windows)]
mod windows_pty;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(not(windows))]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

struct PtyInstance {
    input: pty_input::PtyInput,
    #[cfg(windows)]
    child: windows_pty::WindowsChild,
    #[cfg(not(windows))]
    child: Box<dyn portable_pty::Child + Send + Sync>,
    #[cfg(windows)]
    master: windows_pty::WindowsPty,
    #[cfg(not(windows))]
    master: Box<dyn portable_pty::MasterPty + Send>,
    kill_flag: Arc<AtomicBool>,
    reader: thread::JoinHandle<()>,
}

impl PtyInstance {
    fn close(self) -> Result<(), String> {
        let Self {
            input,
            master,
            child,
            kill_flag,
            reader,
        } = self;
        // Keep draining ConPTY until it closes. Stopping the reader first
        // can block ClosePseudoConsole when its output pipe is full.
        kill_flag.store(true, Ordering::Release);
        #[cfg(windows)]
        let child_result = {
            drop(input);
            child.close()
        };
        #[cfg(not(windows))]
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

    for instance in instances {
        if let Err(error) = instance.close() {
            eprintln!("{error}");
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
    let (master, reader, writer) = windows_pty::WindowsPty::open(24, 80)
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
    let input = pty_input::PtyInput::start(writer)
        .map_err(|e| format!("start input worker failed: {e}"))?;

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
                        let _ = app_handle.emit("pty-output", payload);
                    }
                    Err(_) => break,
                }
            }
            if kill_flag_reader.load(Ordering::Acquire) {
                return;
            }
            let remaining = decoder.finish();
            if !remaining.is_empty() {
                let _ = app_handle.emit(
                    "pty-output",
                    PtyOutput {
                        id: id_for_thread.clone(),
                        data: remaining,
                    },
                );
            }
            let _ = app_handle.emit("pty-exit", id_for_thread);
        })
        .map_err(|e| format!("start output reader failed: {e}"))?;

    #[cfg(windows)]
    let child = master.spawn(cwd.as_deref());
    #[cfg(not(windows))]
    let child = {
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.arg("-NoLogo");
        if let Some(path) = cwd.as_deref().filter(|path| !path.trim().is_empty()) {
            cmd.cwd(path);
        }
        slave.spawn_command(cmd)
    };
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
    id: String,
    input: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let completed = {
        let registry = state.pty.lock().map_err(|_| "PTY registry unavailable")?;
        registry
            .instances
            .get(&id)
            .ok_or("Terminal session is closed")?
            .input
            .enqueue(input)?
    };
    completed
        .await
        .map_err(|_| "Terminal input was cancelled")?
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(usage::UsageState::default())
        .setup(|app| {
            let url =
                start_agent_hook_server(app.handle().clone()).map_err(std::io::Error::other)?;
            let state = app.state::<AppState>();
            if let Ok(mut slot) = state.agent_hook_url.lock() {
                *slot = Some(url);
            }
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
    use super::Utf8OutputDecoder;

    #[cfg(windows)]
    #[test]
    fn concurrent_terminal_close_cancels_blocked_input_only_once() {
        use super::{
            kill_instance, pty_input::tests::blocked_input, windows_pty::WindowsPty, AppState,
            PtyInstance,
        };
        use std::io;
        use std::sync::atomic::AtomicBool;
        use std::sync::{mpsc, Arc, Barrier};
        use std::thread;
        use std::time::Duration;

        let (master, mut output, _writer) = WindowsPty::open(24, 80).unwrap();
        let reader = thread::spawn(move || {
            let _ = io::copy(&mut output, &mut io::sink());
        });
        let child = master.spawn(None).unwrap();
        // The anonymous pipe gives this real session a deterministically
        // blocked Windows writer without depending on ConHost buffer sizes.
        let (blocked_peer, input, blocked) = blocked_input();
        let state = Arc::new(AppState::default());
        state.pty.lock().unwrap().instances.insert(
            "owned".into(),
            PtyInstance {
                input,
                child,
                master,
                kill_flag: Arc::new(AtomicBool::new(false)),
                reader,
            },
        );
        let gate = Arc::new(Barrier::new(3));
        let (finished, results) = mpsc::channel();
        let closers: Vec<_> = (0..2)
            .map(|_| {
                let (state, gate, finished) = (state.clone(), gate.clone(), finished.clone());
                thread::spawn(move || {
                    gate.wait();
                    let _ = finished.send(kill_instance("owned", &state));
                })
            })
            .collect();
        gate.wait();
        let closed: Result<Vec<_>, _> = (0..2)
            .map(|_| results.recv_timeout(Duration::from_secs(10)))
            .collect();
        // Ensure a cancellation regression can still release its own workers.
        drop(blocked_peer);
        for closer in closers {
            closer.join().unwrap();
        }
        let mut closed: Vec<_> = closed.unwrap().into_iter().map(Result::unwrap).collect();
        closed.sort();
        assert_eq!(closed, [false, true]);
        assert!(blocked.blocking_recv().unwrap().is_err());
        assert!(!kill_instance("owned", &state).unwrap());
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
