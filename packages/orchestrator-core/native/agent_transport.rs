//! A private Job Object with bounded stdio forwarding. The job controls process
//! lifetime only. The caller owns protocol, provider and permission policy.
#![cfg(windows)]

mod job_supervisor;

use job_supervisor::Supervised;
use std::env;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, TrySendError};
use std::thread;
use std::time::{Duration, Instant};

enum End {
    ParentClosed,
    AgentClosed,
    InputFailed,
    Backpressure,
    Timeout,
}

fn run() -> io::Result<End> {
    let mut args = env::args_os().skip(1);
    let timeout = args
        .next()
        .and_then(|value| value.to_str()?.parse::<u64>().ok())
        .filter(|value| (1..=600_000).contains(value))
        .ok_or_else(|| io::Error::other("Invalid agent timeout"))?;
    let executable = PathBuf::from(
        args.next()
            .ok_or_else(|| io::Error::other("Missing agent executable"))?,
    );
    let args: Vec<_> = args.collect();
    let args: Vec<_> = args.iter().map(|arg| arg.as_os_str()).collect();
    let allowed = [
        "SystemRoot",
        "WINDIR",
        "PATH",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "CODEX_HOME",
        "GROK_HOME",
        "TMP",
        "TEMP",
    ];
    let values: Vec<_> = allowed
        .iter()
        .filter_map(|&name| env::var_os(name).map(|value| (name, value)))
        .collect();
    let profile: Vec<_> = values
        .iter()
        .map(|(name, value)| (*name, value.as_os_str()))
        .collect();
    let (agent, mut pipes) = Supervised::spawn(&executable, &args, &env::current_dir()?, &profile)?;
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let (events, ended) = mpsc::sync_channel(3);
    let (input, queued) = mpsc::sync_channel::<Vec<u8>>(16);
    let parent_events = events.clone();
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut chunk = [0; 8192];
        let end = loop {
            match stdin.read(&mut chunk) {
                Ok(0) => break End::ParentClosed,
                Ok(size) => match input.try_send(chunk[..size].to_vec()) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => break End::Backpressure,
                    Err(TrySendError::Disconnected(_)) => break End::InputFailed,
                },
                Err(_) => break End::InputFailed,
            }
        };
        // EOF is a control signal even while the agent's stdin is blocked.
        let _ = parent_events.send(end);
    });
    let writer_events = events.clone();
    thread::spawn(move || {
        for chunk in queued {
            if pipes.stdin.write_all(&chunk).is_err() {
                let _ = writer_events.send(End::InputFailed);
                break;
            }
        }
    });
    thread::spawn(move || {
        let _ = io::copy(&mut pipes.stdout, &mut io::stdout().lock());
        let _ = events.send(End::AgentClosed);
    });
    thread::spawn(move || {
        // Never return provider diagnostics that may contain paths or secrets.
        let _ = io::copy(&mut pipes.stderr, &mut io::sink());
    });
    let end = match ended.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(end) => end,
        Err(RecvTimeoutError::Timeout) => End::Timeout,
        Err(RecvTimeoutError::Disconnected) => End::InputFailed,
    };
    let active = agent.active_count()?;
    agent.stop(Duration::from_secs(3))?;
    eprintln!("LAB_M4_JOB_STOP {active} {}", agent.active_count()?);
    Ok(end)
}

fn main() {
    let status = match run() {
        Ok(End::ParentClosed) => 0,
        Ok(End::AgentClosed) => 2,
        Ok(End::InputFailed) => 3,
        Ok(End::Backpressure) => 4,
        Ok(End::Timeout) => 124,
        Err(_) => {
            eprintln!("LAB_M4_JOB_FAILED");
            1
        }
    };
    // The controller already terminated and confirmed its owned tree. Do not
    // wait for forwarding threads that may still be blocked on the parent.
    std::process::exit(status);
}
