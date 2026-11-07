//! Synthetic integration test: no CLI agents, credentials or external requests.
#[cfg(windows)]
mod job_supervisor;
#[cfg(windows)]
fn main() -> std::io::Result<()> {
    use job_supervisor::Supervised;
    use std::ffi::c_void;
    use std::ffi::OsStr;
    use std::io::{BufRead, Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::mpsc::{sync_channel, RecvTimeoutError};
    use std::thread::{sleep, spawn};
    use std::time::{Duration, Instant};
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, millis: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    struct ProcessHandle(*mut c_void);
    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let exe = std::env::current_exe()?;
    match std::env::args().nth(1).as_deref() {
        Some("--worker") => {
            assert_eq!(
                std::env::args().nth(2).as_deref(),
                Some(r#"space "quotes" tail\"#)
            );
            assert_eq!(std::env::var("LAB_M4_TEST_ALLOWED").as_deref(), Ok("žltá"));
            assert!(std::env::var_os("LAB_M4_TEST_PARENT_ONLY").is_none());
            let mut message = String::new();
            std::io::stdin().lock().read_line(&mut message)?;
            assert_eq!(message, "worker input\n");
            std::io::stdout().write_all(b"worker stdout\n")?;
            std::io::stdout().flush()?;
            std::io::stderr().write_all(b"worker stderr\n")?;
            let child = Command::new(&exe)
                .arg("--grandchild")
                .creation_flags(0x0800_0000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
            let signal = std::env::args_os()
                .nth(3)
                .ok_or_else(|| std::io::Error::other("Missing signal path"))?;
            std::fs::write(signal, child.id().to_string())?;
            sleep(Duration::from_secs(30));
        }
        Some("--grandchild") => sleep(Duration::from_secs(30)),
        Some("--unrelated") => sleep(Duration::from_secs(6)),
        None => {
            let mut unrelated = Command::new(&exe)
                .arg("--unrelated")
                .creation_flags(0x0800_0000)
                .spawn()?;
            let outcome = (|| -> std::io::Result<()> {
                let cwd = std::env::current_dir()?;
                std::env::set_var("LAB_M4_TEST_PARENT_ONLY", "must not be inherited");
                let env = [("Lab_M4_Test_Allowed", OsStr::new("žltá"))];
                let duplicate = [env[0], ("LAB_M4_TEST_ALLOWED", OsStr::new("other"))];
                assert!(matches!(
                    Supervised::spawn(&exe, &[], &cwd, &duplicate),
                    Err(error) if error.kind() == std::io::ErrorKind::InvalidInput
                ));
                let signal = std::env::temp_dir()
                    .join(format!("lab-m4-supervisor-test-{}.pid", std::process::id()));
                let _ = std::fs::remove_file(&signal);
                let (process, mut pipes) = Supervised::spawn(
                    &exe,
                    &[
                        OsStr::new("--worker"),
                        OsStr::new(r#"space "quotes" tail\"#),
                        signal.as_os_str(),
                    ],
                    &cwd,
                    &env,
                )?;
                pipes.stdin.write_all(b"worker input\n")?;
                let deadline = Instant::now() + Duration::from_secs(5);
                let child_pid = loop {
                    if let Some(pid) = std::fs::read_to_string(&signal)
                        .ok()
                        .and_then(|s| s.parse::<u32>().ok())
                    {
                        break pid;
                    }
                    if Instant::now() >= deadline {
                        return Err(std::io::Error::other("Expected worker and grandchild"));
                    }
                    sleep(Duration::from_millis(20));
                };
                let _ = std::fs::remove_file(signal);
                let child = ProcessHandle(unsafe { OpenProcess(0x0010_1000, 0, child_pid) });
                if child.0.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                assert!(process.contains_process(child.0)?);
                assert_eq!(unsafe { WaitForSingleObject(child.0, 0) }, 258);
                assert!(process.running()?);
                // The worker no longer reads its input. STOP must unblock a
                // pending host write as well as terminate the owned processes.
                let (written, write_result) = sync_channel(1);
                let writer = spawn(move || {
                    let _ = written.send(pipes.stdin.write_all(&[0; 65536]));
                });
                assert!(matches!(
                    write_result.recv_timeout(Duration::from_millis(150)),
                    Err(RecvTimeoutError::Timeout)
                ));
                process.stop(Duration::from_secs(5))?;
                assert!(matches!(
                    write_result.recv_timeout(Duration::from_secs(5)),
                    Ok(Err(_))
                ));
                writer.join().expect("Input writer panicked");
                assert_eq!(unsafe { WaitForSingleObject(child.0, 0) }, 0);
                assert_eq!(process.active_count()?, 0);
                assert!(!process.running()?);
                assert!(unrelated.try_wait()?.is_none());
                let mut stdout = String::new();
                let mut stderr = String::new();
                pipes.stdout.take(1024).read_to_string(&mut stdout)?;
                pipes.stderr.take(1024).read_to_string(&mut stderr)?;
                assert_eq!(stdout, "worker stdout\n");
                assert_eq!(stderr, "worker stderr\n");
                Ok(())
            })();
            // Never terminate unrelated processes. This owned test process exits naturally.
            unrelated.wait()?;
            outcome?;
            println!("PASS: isolated stdio and environment; job STOP terminated the owned tree");
        }
        _ => return Err(std::io::Error::other("Unsupported synthetic mode")),
    }
    Ok(())
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Windows required");
    std::process::exit(1);
}
