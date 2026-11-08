#![cfg(windows)]

#[allow(dead_code)]
#[path = "../src/pty_input.rs"]
mod pty_input;
#[allow(dead_code)]
#[path = "../src/windows_pty.rs"]
mod windows_pty;
#[allow(dead_code)]
#[path = "../src/windows_pty_host.rs"]
mod windows_pty_host;

use pty_input::PtyInput;
use std::io::{self, Read, Write};
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::null_mut;
use std::sync::{Barrier, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows_pty_host::{HostPipe, WindowsPtyHost, CLEANUP_LIMIT};
use windows_sys::Win32::Foundation::{
    DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::JobObjects::{
    IsProcessInJob, JobObjectBasicAccountingInformation, QueryInformationJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeInfo, PeekNamedPipe};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetProcessId, OpenProcess, WaitForSingleObject,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SUSPEND_RESUME, PROCESS_SYNCHRONIZE,
};

const IO_LIMIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(2);

struct Session {
    host: WindowsPtyHost,
    output: HostPipe,
    input: HostPipe,
}

impl Session {
    fn start() -> Self {
        let (host, output, input) =
            WindowsPtyHost::start_at(Path::new(env!("CARGO_BIN_EXE_wraith")), 100, 30, None)
                .expect("start the shipped terminal helper");
        let mut session = Self {
            host,
            output,
            input,
        };
        session.observe(b"PS ", b"").expect("PowerShell prompt");
        session
    }

    fn send(&mut self, input: &str) -> io::Result<()> {
        send_until(&mut self.input, input.as_bytes(), Instant::now() + IO_LIMIT)
    }

    fn observe(&mut self, marker: &[u8], suffix: &[u8]) -> io::Result<Vec<u8>> {
        let deadline = Instant::now() + IO_LIMIT;
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        let cursor_query = b"\x1b[6n";
        let mut replied = 0;
        loop {
            if Instant::now() >= deadline {
                return Err(io::Error::other("PowerShell output marker timed out"));
            }
            match self.output.read(&mut buffer) {
                Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(count) => output.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(POLL);
                    continue;
                }
                Err(error) => return Err(error),
            }
            if output.len() > 256 * 1024 {
                return Err(io::Error::other("Unexpectedly large PowerShell output"));
            }
            // ConPTY can ask the terminal for its cursor position before showing
            // the initial prompt. Reply as an xterm frontend would.
            let queries = output
                .windows(cursor_query.len())
                .filter(|bytes| *bytes == cursor_query)
                .count();
            while replied < queries {
                send_until(&mut self.input, b"\x1b[1;1R", deadline)?;
                replied += 1;
            }
            if let Some(start) = output
                .windows(marker.len())
                .position(|bytes| bytes == marker)
            {
                let tail = &output[start + marker.len()..];
                if suffix.is_empty() {
                    return Ok(Vec::new());
                }
                if let Some(end) = tail.windows(suffix.len()).position(|bytes| bytes == suffix) {
                    return Ok(tail[..end].to_vec());
                }
            }
        }
    }

    fn shell_and_descendant(&mut self) -> (OwnedHandle, OwnedHandle) {
        self.send(concat!(
            "$p=Start-Process powershell.exe -WindowStyle Hidden -PassThru ",
            "-ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60'; ",
            "Write-Output (('LAB'+'-OWNED=')+$PID+','+$p.Id+':END')\r"
        ))
        .unwrap();
        let pids = self.observe(b"LAB-OWNED=", b":END").unwrap();
        let pids = String::from_utf8(pids).unwrap();
        let (shell, descendant) = pids.split_once(',').expect("shell and descendant IDs");
        (
            open_owned(shell.parse().unwrap(), self.host.job_handle()),
            open_owned(descendant.parse().unwrap(), self.host.job_handle()),
        )
    }

    fn prove_alive(&mut self) {
        self.send("Write-Output (('LAB'+'-SURVIVOR=')+((Get-Date).Year)+':END')\r")
            .unwrap();
        let year = self.observe(b"LAB-SURVIVOR=", b":END").unwrap();
        let year: u32 = String::from_utf8(year).unwrap().parse().unwrap();
        assert!((2020..=2200).contains(&year));
    }
}

fn send_until(writer: &mut HostPipe, mut data: &[u8], deadline: Instant) -> io::Result<()> {
    while !data.is_empty() {
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        match writer.write(data) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(count) => data = &data[count..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(POLL),
            Err(error) => return Err(error),
        }
    }
    writer.flush()
}

fn retain(handle: HANDLE) -> OwnedHandle {
    let process = unsafe { GetCurrentProcess() };
    let mut duplicate = null_mut();
    assert_ne!(
        unsafe {
            DuplicateHandle(
                process,
                handle,
                process,
                &mut duplicate,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        },
        0,
        "duplicate the test's own handle: {}",
        io::Error::last_os_error()
    );
    unsafe { OwnedHandle::from_raw_handle(duplicate) }
}

fn assert_in_job(process: HANDLE, job: HANDLE) {
    let mut belongs = 0;
    assert_ne!(unsafe { IsProcessInJob(process, job, &mut belongs) }, 0);
    assert_ne!(belongs, 0, "the fixture must belong to its session job");
}

fn open_owned(pid: u32, job: HANDLE) -> OwnedHandle {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_SUSPEND_RESUME,
            0,
            pid,
        )
    };
    assert!(
        !process.is_null(),
        "open owned fixture: {}",
        io::Error::last_os_error()
    );
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    assert_in_job(process.as_raw_handle(), job);
    process
}

fn suspend_owned(process: &OwnedHandle, job: HANDLE) {
    // Test-only fault injection. Never suspend a process outside this test job.
    #[link(name = "ntdll")]
    extern "system" {
        fn NtSuspendProcess(process: HANDLE) -> i32;
    }
    let handle = process.as_raw_handle();
    assert_in_job(handle, job);
    let pid = unsafe { GetProcessId(handle) };
    assert_ne!(pid, 0);
    assert_ne!(pid, unsafe { GetCurrentProcessId() });
    assert_eq!(unsafe { WaitForSingleObject(handle, 0) }, WAIT_TIMEOUT);
    let status = unsafe { NtSuspendProcess(handle) };
    assert!(
        status >= 0,
        "suspending owned test process failed: {status:#x}"
    );
}

fn assert_job_empty(job: &OwnedHandle, processes: &[&OwnedHandle]) {
    let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    assert_ne!(
        unsafe {
            QueryInformationJobObject(
                job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        },
        0
    );
    assert_eq!(info.ActiveProcesses, 0);
    for process in processes {
        assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
    }
}

#[test]
fn broker_close_cancels_backpressured_input_and_joins_the_worker_once() {
    let mut blocked = Session::start();
    let (shell, descendant) = blocked.shell_and_descendant();
    let broker = retain(blocked.host.process_handle());
    let job = retain(blocked.host.job_handle());
    let mut survivor = Session::start();

    suspend_owned(&shell, job.as_raw_handle());
    let fill_deadline = Instant::now() + IO_LIMIT;
    loop {
        assert!(
            Instant::now() < fill_deadline,
            "fixture did not backpressure input"
        );
        // No newline. These bytes cannot form an executed command.
        match blocked.input.write(&[b'x'; 4096]) {
            Ok(1..) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            other => panic!("unexpected nonblocking pipe result: {other:?}"),
        }
    }

    let input = PtyInput::start(blocked.input).unwrap();
    let mut pending = input.enqueue("x".repeat(256 * 1024)).unwrap();
    assert!(matches!(
        pending.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    // Keep the output pipe open. Force the timeout path by making graceful
    // shutdown impossible for this one already-owned broker.
    suspend_owned(&broker, job.as_raw_handle());
    let entry = Mutex::new(Some((blocked.host, input)));
    let ready = Barrier::new(2);
    let deadline = Instant::now() + CLEANUP_LIMIT;
    let close = || {
        ready.wait();
        let owned = entry.lock().unwrap().take();
        if let Some((host, mut input)) = owned {
            input.begin_close();
            let stopped = host.close_by(deadline);
            let joined = input.finish_by(deadline);
            stopped.expect("close blocked input job");
            joined.expect("join the app input worker");
            true
        } else {
            false
        }
    };
    thread::scope(|scope| {
        let first = scope.spawn(close);
        let second = scope.spawn(close);
        assert_ne!(first.join().unwrap(), second.join().unwrap());
    });
    assert!(
        Instant::now() <= deadline,
        "combined close exceeded its shared deadline"
    );
    assert_job_empty(&job, &[&broker, &shell, &descendant]);
    assert!(matches!(
        pending.try_recv(),
        Ok(Err(_)) | Err(tokio::sync::oneshot::error::TryRecvError::Closed)
    ));

    survivor.prove_alive();
    survivor
        .host
        .close_by(Instant::now() + CLEANUP_LIMIT)
        .unwrap();
}

fn await_full_output(pipe: &HostPipe) {
    let handle = pipe.as_raw_handle();
    let (mut outbound, mut inbound) = (0, 0);
    assert_ne!(
        unsafe { GetNamedPipeInfo(handle, null_mut(), &mut outbound, &mut inbound, null_mut()) },
        0,
        "read owned pipe capacity"
    );
    let capacity = inbound.max(outbound);
    assert!(capacity > 0);
    let deadline = Instant::now() + IO_LIMIT;
    loop {
        let mut available = 0;
        assert_ne!(
            unsafe {
                PeekNamedPipe(
                    handle,
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            },
            0,
            "inspect owned output without draining"
        );
        if available >= capacity {
            return;
        }
        assert!(Instant::now() < deadline, "fixture did not saturate output");
        thread::sleep(POLL);
    }
}

fn assert_output_closed(pipe: &mut HostPipe, deadline: Instant) {
    let mut buffer = [0; 4096];
    loop {
        assert!(
            Instant::now() <= deadline,
            "output pipe did not close before deadline"
        );
        match pipe.read(&mut buffer) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(POLL),
            Err(error) => panic!("could not verify closed output: {error}"),
        }
    }
}

#[test]
fn broker_close_stops_saturated_output_and_all_descendants_without_draining() {
    let mut blocked = Session::start();
    let (shell, descendant) = blocked.shell_and_descendant();
    let broker = retain(blocked.host.process_handle());
    let job = retain(blocked.host.job_handle());
    let mut survivor = Session::start();

    blocked
        .send(concat!(
            "Write-Output (('LAB'+'-OUTPUT=')+'START:END'); ",
            "while($true){[Console]::WriteLine('x'*2048)}\r"
        ))
        .unwrap();
    assert_eq!(blocked.observe(b"LAB-OUTPUT=", b":END").unwrap(), b"START");
    await_full_output(&blocked.output);

    // The application's side stays open and nobody drains it during close.
    let deadline = Instant::now() + CLEANUP_LIMIT;
    blocked
        .host
        .close_by(deadline)
        .expect("close saturated output");
    assert!(
        Instant::now() <= deadline,
        "output cleanup exceeded its shared deadline"
    );
    assert_job_empty(&job, &[&broker, &shell, &descendant]);
    assert_output_closed(&mut blocked.output, deadline);

    survivor.prove_alive();
    survivor
        .host
        .close_by(Instant::now() + CLEANUP_LIMIT)
        .unwrap();
}
