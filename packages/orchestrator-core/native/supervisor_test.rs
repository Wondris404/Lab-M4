//! Synthetic integration test: no CLI agents, credentials or external requests.
#[cfg(windows)]
mod job_supervisor;
#[cfg(windows)]
fn main() -> std::io::Result<()> {
    use job_supervisor::Supervised;
    use std::ffi::c_void;
    use std::ffi::OsStr;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::thread::sleep;
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
            let child = Command::new(&exe)
                .arg("--grandchild")
                .creation_flags(0x0800_0000)
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
                let signal = std::env::temp_dir()
                    .join(format!("lab-m4-supervisor-test-{}.pid", std::process::id()));
                let _ = std::fs::remove_file(&signal);
                let process = Supervised::spawn(
                    &exe,
                    &[
                        OsStr::new("--worker"),
                        OsStr::new(r#"space "quotes" tail\"#),
                        signal.as_os_str(),
                    ],
                    &cwd,
                )?;
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
                process.stop(Duration::from_secs(5))?;
                assert_eq!(unsafe { WaitForSingleObject(child.0, 0) }, 0);
                assert_eq!(process.active_count()?, 0);
                assert!(!process.running()?);
                assert!(unrelated.try_wait()?.is_none());
                Ok(())
            })();
            // Never terminate unrelated processes. This owned test process exits naturally.
            unrelated.wait()?;
            outcome?;
            println!(
                "PASS: reusable job STOP terminated the owned tree; unrelated process survived"
            );
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
