//! A private Job Object with bounded stdio forwarding. The job controls process
//! lifetime only. The caller owns protocol, provider and permission policy.
#![cfg(windows)]

mod job_supervisor;

use job_supervisor::Supervised;
use std::env;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender, TrySendError};
use std::thread;
use std::time::{Duration, Instant};

enum End {
    ParentClosed,
    AgentClosed,
    InputFailed,
    Backpressure,
    Timeout,
    Stopped,
}

enum Note {
    ParentEof,
    AgentClosed,
    InputFailed,
    Backpressure,
    Stopped,
}

enum ParentInput {
    Bytes(Vec<u8>),
    Eof,
}

fn result_name(end: &End) -> &'static str {
    match end {
        End::ParentClosed => "parent-closed",
        End::AgentClosed => "agent-closed",
        End::InputFailed => "input-failed",
        End::Backpressure => "backpressure",
        End::Timeout => "timeout",
        End::Stopped => "stop",
    }
}

fn queue_bytes(input: &SyncSender<ParentInput>, mut data: Vec<u8>) -> Result<(), End> {
    while !data.is_empty() {
        let piece = data.drain(..data.len().min(8192)).collect();
        match input.try_send(ParentInput::Bytes(piece)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => return Err(End::Backpressure),
            Err(TrySendError::Disconnected(_)) => return Err(End::InputFailed),
        }
    }
    Ok(())
}

/// Hold a trailing prefix of `LAB_M4_STOP` so a marker split across reads is not
/// forwarded. Any other bytes are returned for the ordered queue.
fn split_hold(buf: &[u8]) -> usize {
    let marker = b"LAB_M4_STOP";
    let max = buf.len().min(marker.len());
    (1..=max)
        .rev()
        .find(|&len| buf.ends_with(&marker[..len]))
        .unwrap_or(0)
}

/// Forward complete lines in order. `LAB_M4_STOP` is consumed and never written
/// to the agent. `Ok(true)` means that marker was seen.
fn drain(carry: &mut Vec<u8>, input: &SyncSender<ParentInput>) -> Result<bool, End> {
    loop {
        if let Some(pos) = carry.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = carry.drain(..=pos).collect();
            if line == b"LAB_M4_STOP\n" || line == b"LAB_M4_STOP\r\n" {
                return Ok(true);
            }
            queue_bytes(input, line)?;
        } else {
            let hold = split_hold(carry);
            let flush_end = carry.len() - hold;
            if flush_end == 0 {
                break;
            }
            let data = carry.drain(..flush_end).collect();
            queue_bytes(input, data)?;
            break;
        }
    }
    Ok(false)
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
    let (events, ended) = mpsc::sync_channel(8);
    let (input, queued) = mpsc::sync_channel(16);
    let parent_events = events.clone();
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut chunk = [0; 8192];
        let mut carry = Vec::new();
        let end = loop {
            match stdin.read(&mut chunk) {
                Ok(0) => {
                    if !carry.is_empty() {
                        if let Err(end) = queue_bytes(&input, std::mem::take(&mut carry)) {
                            break end;
                        }
                    }
                    break match input.try_send(ParentInput::Eof) {
                        Ok(()) => return,
                        Err(TrySendError::Full(_)) => End::Backpressure,
                        Err(TrySendError::Disconnected(_)) => End::InputFailed,
                    };
                }
                Ok(size) => {
                    carry.extend_from_slice(&chunk[..size]);
                    match drain(&mut carry, &input) {
                        Ok(true) => break End::Stopped,
                        Ok(false) => {}
                        Err(end) => break end,
                    }
                }
                Err(_) => break End::InputFailed,
            }
        };
        let note = match end {
            End::Stopped => Note::Stopped,
            End::Backpressure => Note::Backpressure,
            _ => Note::InputFailed,
        };
        let _ = parent_events.send(note);
    });
    let writer_events = events.clone();
    thread::spawn(move || {
        while let Ok(message) = queued.recv() {
            match message {
                ParentInput::Bytes(chunk) => {
                    if pipes.stdin.write_all(&chunk).is_err() {
                        let _ = writer_events.send(Note::InputFailed);
                        break;
                    }
                }
                ParentInput::Eof => {
                    drop(pipes.stdin);
                    let _ = writer_events.send(Note::ParentEof);
                    break;
                }
            }
        }
    });
    thread::spawn(move || {
        let _ = io::copy(&mut pipes.stdout, &mut io::stdout().lock());
        let _ = events.send(Note::AgentClosed);
    });
    thread::spawn(move || {
        // Never return provider diagnostics that may contain paths or secrets.
        let _ = io::copy(&mut pipes.stderr, &mut io::sink());
    });
    let mut parent_eof = false;
    let end = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break End::Timeout;
        }
        match ended.recv_timeout(remaining) {
            Ok(Note::ParentEof) => parent_eof = true,
            Ok(Note::AgentClosed) => {
                break if parent_eof {
                    End::ParentClosed
                } else {
                    End::AgentClosed
                };
            }
            Ok(Note::InputFailed) => break End::InputFailed,
            Ok(Note::Backpressure) => break End::Backpressure,
            Ok(Note::Stopped) => break End::Stopped,
            Err(RecvTimeoutError::Timeout) => break End::Timeout,
            Err(RecvTimeoutError::Disconnected) => break End::InputFailed,
        }
    };
    let active = agent.active_count()?;
    eprintln!("LAB_M4_RESULT {}", result_name(&end));
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
        Ok(End::Stopped) => 5,
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
