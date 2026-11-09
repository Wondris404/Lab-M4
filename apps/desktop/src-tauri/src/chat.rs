use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
    Arc, Mutex,
};
use tauri::WebviewWindow;
use tokio::sync::oneshot;

#[cfg(windows)]
mod acp;
#[cfg(windows)]
mod codex;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Platform {
    Codex,
    GrokBuild,
    Opencode,
}

impl Platform {
    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex CLI",
            Self::GrokBuild => "Grok Build",
            Self::Opencode => "OpenCode",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDelta<'a> {
    request_id: u32,
    text: &'a str,
}

#[derive(Clone, Serialize)]
struct Choice {
    id: String,
    name: String,
    description: Option<String>,
}

#[derive(Clone, Default, Serialize)]
struct ModelOptions {
    speed: Vec<Choice>,
    thinking: Vec<Choice>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCatalog {
    models: Vec<Model>,
    default_model: Option<String>,
    options: ModelOptions,
}

#[derive(Clone, Serialize)]
struct Model {
    id: String,
    name: String,
    options: ModelOptions,
    #[serde(skip)]
    default_thinking: Option<String>,
}

struct Turn {
    window: WebviewWindow,
    request_id: u32,
    message: String,
    model: Option<String>,
    speed: Option<String>,
    thinking: Option<String>,
    cancel: Arc<AtomicBool>,
}

enum Operation {
    Send(Box<Turn>),
    Models {
        model: Option<String>,
        cancel: Arc<AtomicBool>,
    },
}

type Reply = oneshot::Sender<Result<Value, String>>;
enum Command {
    Request(Platform, Operation, Reply),
    Reset(Platform),
}

type Pending = Arc<Mutex<Option<(Option<u32>, Arc<AtomicBool>)>>>;

#[derive(Default)]
pub(crate) struct ChatState {
    sender: Mutex<Option<SyncSender<Command>>>,
    pending: Pending,
}

impl ChatState {
    pub(crate) fn close(&self) {
        // Keep the same lock order as enqueue and reset.
        if let (Ok(mut sender), Ok(pending)) = (self.sender.lock(), self.pending.lock()) {
            sender.take();
            if let Some((_, cancel)) = pending.as_ref() {
                cancel.store(true, Ordering::Release);
            }
        }
    }

    async fn request(
        &self,
        platform: Platform,
        request_id: Option<u32>,
        operation: Operation,
        cancel: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        let (reply, result) = oneshot::channel();
        {
            let mut sender = self.sender.lock().map_err(|_| "Chat je nedostupný.")?;
            let mut pending = self.pending.lock().map_err(|_| "Chat je nedostupný.")?;
            if pending.is_some() {
                return Err("Počkaj na načítanie modelov alebo dokončenie odpovede.".into());
            }
            let channel = sender.get_or_insert_with(|| start_worker(self.pending.clone()));
            channel
                .try_send(Command::Request(platform, operation, reply))
                .map_err(|_| "Chat nedokázal spustiť požiadavku.")?;
            *pending = Some((request_id, cancel));
        }
        result
            .await
            .map_err(|_| "Pripojenie k chatu sa ukončilo.")?
    }
}

#[tauri::command]
pub(crate) async fn chat_models(
    state: tauri::State<'_, ChatState>,
    platform: Platform,
    model: Option<String>,
) -> Result<Value, String> {
    let model = selection_value(model)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .request(
            platform,
            None,
            Operation::Models {
                model,
                cancel: cancel.clone(),
            },
            cancel,
        )
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Keep the existing flat Tauri invoke payload.
pub(crate) async fn chat_send(
    window: WebviewWindow,
    state: tauri::State<'_, ChatState>,
    request_id: u32,
    message: String,
    platform: Option<Platform>,
    model: Option<String>,
    speed: Option<String>,
    thinking: Option<String>,
) -> Result<Value, String> {
    let platform = platform.unwrap_or(Platform::Codex);
    let message = message.trim();
    if message.is_empty() || message.len() > 32 * 1024 {
        return Err("Správa musí mať od 1 do 32 768 bajtov.".into());
    }
    if platform == Platform::Opencode && message.starts_with('/') {
        return Err("OpenCode príkazy začínajúce lomkou patria do terminálu.".into());
    }
    let model = selection_value(model)?;
    let speed = selection_value(speed)?;
    let thinking = selection_value(thinking)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let turn = Turn {
        window,
        request_id,
        message: message.to_owned(),
        model,
        speed,
        thinking,
        cancel: cancel.clone(),
    };
    state
        .request(
            platform,
            Some(request_id),
            Operation::Send(Box::new(turn)),
            cancel,
        )
        .await
}

fn selection_value(value: Option<String>) -> Result<Option<String>, String> {
    let value = value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if value
        .as_ref()
        .is_some_and(|value| value.len() > 180 || value.chars().any(char::is_control))
    {
        return Err("Neplatná voľba modelu.".into());
    }
    Ok(value)
}

#[tauri::command]
pub(crate) fn chat_stop(state: tauri::State<'_, ChatState>, request_id: u32) -> Result<(), String> {
    let pending = state.pending.lock().map_err(|_| "Chat je nedostupný.")?;
    if let Some((_, cancel)) = pending.as_ref().filter(|(id, _)| *id == Some(request_id)) {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn chat_reset(
    state: tauri::State<'_, ChatState>,
    platform: Option<Platform>,
) -> Result<(), String> {
    let sender = state.sender.lock().map_err(|_| "Chat je nedostupný.")?;
    let pending = state.pending.lock().map_err(|_| "Chat je nedostupný.")?;
    if pending.is_some() {
        return Err("Najprv počkaj na dokončenie alebo zastav odpoveď.".into());
    }
    if let Some(sender) = sender.as_ref() {
        sender
            .try_send(Command::Reset(platform.unwrap_or(Platform::Codex)))
            .map_err(|_| "Chat je nedostupný.")?;
    }
    Ok(())
}

#[cfg(windows)]
enum Connection {
    Codex(codex::Session),
    Acp(acp::Session),
}

#[cfg(windows)]
impl Connection {
    fn start(platform: Platform, cancel: &AtomicBool) -> Result<Self, String> {
        match platform {
            Platform::Codex => codex::Session::start(cancel).map(Self::Codex),
            _ => acp::Session::start(platform, cancel).map(Self::Acp),
        }
    }

    fn run(&mut self, operation: Operation) -> Result<Value, String> {
        match operation {
            Operation::Send(turn) => {
                let text = match self {
                    Self::Codex(session) => session.answer(&turn),
                    Self::Acp(session) => session.answer(&turn),
                }?;
                Ok(Value::String(text))
            }
            Operation::Models { model, cancel } => {
                let catalog = match self {
                    Self::Codex(session) => session.catalog(&cancel)?,
                    Self::Acp(session) => session.catalog(model.as_deref(), &cancel)?,
                };
                serde_json::to_value(catalog)
                    .map_err(|_| "Zoznam modelov sa nepodarilo načítať.".into())
            }
        }
    }
}

fn start_worker(pending: Pending) -> SyncSender<Command> {
    let (sender, commands) = mpsc::sync_channel(2);
    std::thread::spawn(move || {
        #[cfg(windows)]
        let mut sessions = std::collections::HashMap::new();
        while let Ok(command) = commands.recv() {
            let (platform, operation, reply) = match command {
                Command::Request(platform, operation, reply) => (platform, operation, reply),
                Command::Reset(_platform) => {
                    #[cfg(windows)]
                    sessions.remove(&_platform);
                    continue;
                }
            };
            #[cfg(windows)]
            let result = (|| {
                let cancel = match &operation {
                    Operation::Send(turn) => &turn.cancel,
                    Operation::Models { cancel, .. } => cancel,
                };
                if cancel.load(Ordering::Acquire) {
                    return Err("Odpoveď bola zastavená.".into());
                }
                let session = match sessions.entry(platform) {
                    std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert(Connection::start(platform, cancel)?)
                    }
                };
                session.run(operation)
            })();
            #[cfg(windows)]
            if result.is_err() {
                sessions.remove(&platform);
            }
            #[cfg(not(windows))]
            let result = Err(format!(
                "{} je v Lab-M4 dostupný vo Windows.",
                platform.label()
            ));
            if let Ok(mut pending) = pending.lock() {
                *pending = None;
            }
            let _ = reply.send(result);
        }
    });
    sender
}
