//! Synthetic integration test: no CLI agents, credentials or external requests.
#[cfg(windows)]
mod job_supervisor;
#[cfg(windows)]
fn main() -> std::io::Result<()> {
    use job_supervisor::Supervised;
    use std::ffi::OsStr;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::thread::sleep;
    use std::time::{Duration, Instant};
    let exe = std::env::current_exe()?;
    match std::env::args().nth(1).as_deref() {
        Some("--worker") => {
            assert_eq!(
                std::env::args().nth(2).as_deref(),
                Some(r#"space "quotes" tail\"#)
            );
            Command::new(&exe)
                .arg("--grandchild")
                .creation_flags(0x0800_0000)
                .spawn()?;
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
                let process = Supervised::spawn(
                    &exe,
                    &[
                        OsStr::new("--worker"),
                        OsStr::new(r#"space "quotes" tail\"#),
                    ],
                    &cwd,
                )?;
                let deadline = Instant::now() + Duration::from_secs(5);
                while process.active_count()? != 2 {
                    if Instant::now() >= deadline {
                        return Err(std::io::Error::other("Expected worker and grandchild"));
                    }
                    sleep(Duration::from_millis(20));
                }
                assert!(process.running()?);
                process.stop(Duration::from_secs(5))?;
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
