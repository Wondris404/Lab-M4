use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
    Arc, Mutex,
};
use tauri::WebviewWindow;
use tokio::sync::oneshot;

#[cfg(windows)]
mod codex;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDelta<'a> {
    request_id: u32,
    text: &'a str,
}

struct Turn {
    window: WebviewWindow,
    request_id: u32,
    message: String,
    cancel: Arc<AtomicBool>,
    reply: oneshot::Sender<Result<String, String>>,
}

enum Command {
    Send(Turn),
    Reset,
}

type Pending = Arc<Mutex<Option<(u32, Arc<AtomicBool>)>>>;

#[derive(Default)]
pub(crate) struct ChatState {
    sender: Mutex<Option<SyncSender<Command>>>,
    pending: Pending,
}

impl ChatState {
    pub(crate) fn close(&self) {
        if let Ok(pending) = self.pending.lock() {
            if let Some((_, cancel)) = pending.as_ref() {
                cancel.store(true, Ordering::Release);
            }
        }
        if let Ok(mut sender) = self.sender.lock() {
            sender.take();
        }
    }
}

#[tauri::command]
pub(crate) async fn chat_send(
    window: WebviewWindow,
    state: tauri::State<'_, ChatState>,
    request_id: u32,
    message: String,
) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() || message.len() > 32 * 1024 {
        return Err("Správa musí mať od 1 do 32 768 bajtov.".into());
    }
    let (reply, result) = oneshot::channel();
    {
        let mut sender = state.sender.lock().map_err(|_| "Chat je nedostupný.")?;
        let mut pending = state.pending.lock().map_err(|_| "Chat je nedostupný.")?;
        if pending.is_some() {
            return Err("Počkaj na odpoveď alebo ju zastav.".into());
        }
        let channel = sender.get_or_insert_with(|| start_worker(state.pending.clone()));
        let cancel = Arc::new(AtomicBool::new(false));
        channel
            .try_send(Command::Send(Turn {
                window,
                request_id,
                message: message.to_owned(),
                cancel: cancel.clone(),
                reply,
            }))
            .map_err(|_| "Chat nedokázal spustiť požiadavku.")?;
        *pending = Some((request_id, cancel));
    }
    result
        .await
        .map_err(|_| "Pripojenie k chatu sa ukončilo.")?
}

#[tauri::command]
pub(crate) fn chat_stop(state: tauri::State<'_, ChatState>, request_id: u32) -> Result<(), String> {
    let pending = state.pending.lock().map_err(|_| "Chat je nedostupný.")?;
    if let Some((_, cancel)) = pending.as_ref().filter(|(id, _)| *id == request_id) {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn chat_reset(state: tauri::State<'_, ChatState>) -> Result<(), String> {
    let sender = state.sender.lock().map_err(|_| "Chat je nedostupný.")?;
    let pending = state.pending.lock().map_err(|_| "Chat je nedostupný.")?;
    if pending.is_some() {
        return Err("Najprv zastav aktuálnu odpoveď.".into());
    }
    if let Some(sender) = sender.as_ref() {
        sender
            .try_send(Command::Reset)
            .map_err(|_| "Chat je nedostupný.")?;
    }
    Ok(())
}

fn start_worker(pending: Pending) -> SyncSender<Command> {
    let (sender, commands) = mpsc::sync_channel(2);
    std::thread::spawn(move || {
        #[cfg(windows)]
        let mut session = None;
        while let Ok(command) = commands.recv() {
            let turn = match command {
                Command::Send(turn) => turn,
                Command::Reset => {
                    #[cfg(windows)]
                    {
                        session = None;
                    }
                    continue;
                }
            };
            #[cfg(windows)]
            let result = codex::send(&mut session, &turn);
            #[cfg(not(windows))]
            let result = Err("Pripojenie Codex chatu je dostupné vo Windows.".into());
            if let Ok(mut pending) = pending.lock() {
                *pending = None;
            }
            let _ = turn.reply.send(result);
        }
    });
    sender
}
