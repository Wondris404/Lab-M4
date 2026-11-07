use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use tokio::sync::oneshot;

const MAX_INPUT_BYTES: usize = 256 * 1024;
const QUEUE_CAPACITY: usize = 8;

struct Request {
    input: String,
    result: oneshot::Sender<Result<(), String>>,
}

pub(crate) struct PtyInput {
    queue: Option<SyncSender<Request>>,
    worker: Option<JoinHandle<()>>,
    closing: Arc<AtomicBool>,
}

impl PtyInput {
    pub(crate) fn start(mut writer: impl Write + Send + 'static) -> io::Result<Self> {
        let (queue, requests) = mpsc::sync_channel::<Request>(QUEUE_CAPACITY);
        let closing = Arc::new(AtomicBool::new(false));
        let stop = closing.clone();
        let worker = thread::Builder::new()
            .name("pty-input".into())
            .spawn(move || {
                for request in requests {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let result = writer
                        .write_all(request.input.as_bytes())
                        .and_then(|()| writer.flush())
                        .map_err(|error| format!("PTY input write failed: {error}"));
                    let failed = result.is_err();
                    let _ = request.result.send(result);
                    if failed {
                        // A partial write cannot safely be retried or followed by
                        // later input whose interpretation may have changed.
                        break;
                    }
                }
            })?;
        Ok(Self {
            queue: Some(queue),
            worker: Some(worker),
            closing,
        })
    }

    pub(crate) fn enqueue(
        &self,
        input: String,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        if input.len() > MAX_INPUT_BYTES {
            return Err("Terminal input exceeds 256 KiB".into());
        }
        let (result, completed) = oneshot::channel();
        self.queue
            .as_ref()
            .ok_or("Terminal input is closed")?
            .try_send(Request { input, result })
            .map_err(|error| match error {
                TrySendError::Full(_) => "Terminal input queue is full".to_owned(),
                TrySendError::Disconnected(_) => "Terminal input is closed".to_owned(),
            })?;
        Ok(completed)
    }
}

impl Drop for PtyInput {
    fn drop(&mut self) {
        self.closing.store(true, Ordering::Release);
        self.queue.take();
        if let Some(worker) = self.worker.take() {
            #[cfg(windows)]
            cancel_blocking_write(&worker);
            let _ = worker.join();
        }
    }
}

#[cfg(windows)]
fn cancel_blocking_write(worker: &JoinHandle<()>) {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::time::Duration;

    #[link(name = "kernel32")]
    extern "system" {
        fn CancelSynchronousIo(thread: *mut c_void) -> i32;
    }

    // A write can enter the kernel just after the closing flag is set.
    // Cancel until the thread exits, then join it before releasing the PTY.
    while !worker.is_finished() {
        unsafe { CancelSynchronousIo(worker.as_raw_handle()) };
        thread::sleep(Duration::from_millis(1));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::io::FromRawHandle;
    use std::ptr::null_mut;
    use std::time::Duration;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreatePipe(
            read: *mut *mut c_void,
            write: *mut *mut c_void,
            security: *mut c_void,
            size: u32,
        ) -> i32;
    }

    struct SignalledPipe(File, mpsc::Sender<()>);

    impl Write for SignalledPipe {
        fn write(&mut self, data: &[u8]) -> io::Result<usize> {
            let _ = self.1.send(());
            self.0.write(data)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    #[test]
    fn close_cancels_a_blocked_windows_pipe_and_rejects_queued_input() {
        let (mut read, mut write) = (null_mut(), null_mut());
        assert_ne!(
            unsafe { CreatePipe(&mut read, &mut write, null_mut(), 4096) },
            0
        );
        let read = unsafe { File::from_raw_handle(read) };
        let write = unsafe { File::from_raw_handle(write) };
        let (started, writing) = mpsc::channel();
        let input = PtyInput::start(SignalledPipe(write, started)).unwrap();
        let mut blocked = input.enqueue("x".repeat(MAX_INPUT_BYTES)).unwrap();
        writing.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            blocked.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        let queued: Vec<_> = (0..QUEUE_CAPACITY)
            .map(|_| input.enqueue("pending".into()).unwrap())
            .collect();
        assert_eq!(
            input.enqueue("overflow".into()).unwrap_err(),
            "Terminal input queue is full"
        );

        let (closed, completion) = mpsc::channel();
        let closer = thread::spawn(move || {
            drop(input);
            let _ = closed.send(());
        });
        let closed_without_reader = completion.recv_timeout(Duration::from_secs(2));
        // Release the peer even on regression so the test can join its own thread.
        drop(read);
        closer.join().unwrap();
        closed_without_reader.unwrap();
        assert!(blocked.blocking_recv().unwrap().is_err());
        assert!(queued
            .into_iter()
            .all(|request| request.blocking_recv().is_err()));
    }
}
