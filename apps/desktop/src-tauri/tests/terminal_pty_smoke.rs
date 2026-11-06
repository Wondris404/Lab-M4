#![cfg(windows)]

use portable_pty::{native_pty_system, Child, CommandBuilder, PtyPair, PtySize};
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

struct Session {
    _pair: PtyPair,
    child: Box<dyn Child + Send + Sync>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    ready: mpsc::Receiver<()>,
    date: mpsc::Receiver<()>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

fn new_session() -> Session {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open PTY");
    let mut command = CommandBuilder::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile"]);
    let child = pair.slave.spawn_command(command).expect("spawn PowerShell");
    let mut reader = pair.master.try_clone_reader().expect("clone reader");
    let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("take writer")));
    let response = Arc::clone(&writer);
    let (ready_tx, ready) = mpsc::channel();
    let (date_tx, date) = mpsc::channel();
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut announced = false;
        while let Ok(count) = reader.read(&mut chunk) {
            if count == 0 || output.len() + count > 1024 * 1024 {
                break;
            }
            output.extend_from_slice(&chunk[..count]);
            if !announced && output.windows(4).any(|value| value == b"\x1b[6n") {
                let Ok(mut writer) = response.lock() else {
                    break;
                };
                if writer
                    .write_all(b"\x1b[1;1R")
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
                announced = true;
                let _ = ready_tx.send(());
            } else if !announced && output.windows(3).any(|value| value == b"PS ") {
                announced = true;
                let _ = ready_tx.send(());
            }
            if output
                .windows(b"LAB_M4_DATE_SUCCESS".len())
                .any(|value| value == b"LAB_M4_DATE_SUCCESS")
            {
                let _ = date_tx.send(());
                break;
            }
        }
    });
    Session {
        _pair: pair,
        child,
        writer,
        ready,
        date,
    }
}

fn run_date(session: &Session) {
    let mut writer = session.writer.lock().expect("writer lock");
    writer.write_all(b"$d = Get-Date; if ($d -is [datetime]) { Write-Output ('LAB_M4_DATE_' + 'SUCCESS') }; exit\r\n").expect("write command");
    writer.flush().expect("flush command");
}

#[test]
#[ignore = "requires native Windows ConPTY and PowerShell; run explicitly"]
fn powershell_ptys_accept_input_and_close_independently() {
    let mut first = new_session();
    let mut second = new_session();
    first
        .ready
        .recv_timeout(Duration::from_secs(15))
        .expect("first PTY ready");
    second
        .ready
        .recv_timeout(Duration::from_secs(15))
        .expect("second PTY ready");
    run_date(&first);
    first
        .date
        .recv_timeout(Duration::from_secs(15))
        .expect("first Get-Date");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = first.child.try_wait().expect("first exit status") {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline, "first session failed to exit");
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        second.child.try_wait().expect("second state").is_none(),
        "second session must remain alive"
    );
    run_date(&second);
    second
        .date
        .recv_timeout(Duration::from_secs(15))
        .expect("second Get-Date");
}
