use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{self, Path, PathBuf};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    UpdateProcThreadAttribute, WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

pub(crate) struct WindowsPty(HPCON);

fn pipe() -> io::Result<(File, File)> {
    let (mut reader, mut writer) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut reader, &mut writer, null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (File::from_raw_handle(reader), File::from_raw_handle(writer)) })
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut buffer: Vec<_> = value.encode_wide().collect();
    if buffer.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Embedded NUL in path",
        ));
    }
    buffer.push(0);
    Ok(buffer)
}

fn powershell_path() -> io::Result<PathBuf> {
    let mut buffer = [0u16; 260];
    let len = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if len == 0 {
        return Err(io::Error::last_os_error());
    }
    if len >= buffer.len() {
        return Err(io::Error::other("Windows system directory is too long"));
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..len]))
        .join(r"WindowsPowerShell\v1.0\powershell.exe"))
}

struct Attributes(Vec<usize>);

impl Attributes {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes) };
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        if unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut bytes)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(storage))
    }

    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.0.as_mut_ptr().cast()
    }

    fn set(&mut self, key: u32, value: *const c_void, size: usize) -> io::Result<()> {
        if unsafe {
            UpdateProcThreadAttribute(self.ptr(), 0, key as usize, value, size, null_mut(), null())
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.ptr()) };
    }
}

impl WindowsPty {
    pub(crate) fn open(rows: i16, cols: i16) -> io::Result<(Self, File, File)> {
        let (console_input, writer) = pipe()?;
        let (reader, console_output) = pipe()?;
        let mut console = 0;
        let status = unsafe {
            CreatePseudoConsole(
                COORD { X: cols, Y: rows },
                console_input.as_raw_handle(),
                console_output.as_raw_handle(),
                0,
                &mut console,
            )
        };
        if status < 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
        Ok((Self(console), reader, writer))
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let x = i16::try_from(cols).ok().filter(|v| *v > 0);
        let y = i16::try_from(rows).ok().filter(|v| *v > 0);
        let (Some(x), Some(y)) = (x, y) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid console dimensions",
            ));
        };
        let status = unsafe { ResizePseudoConsole(self.0, COORD { X: x, Y: y }) };
        if status < 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
        Ok(())
    }

    pub(crate) fn spawn(&self, cwd: Option<&str>) -> io::Result<WindowsChild> {
        let cwd = cwd
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(PathBuf::from)
                    .filter(|path| path.is_dir())
            })
            .map(path::absolute)
            .transpose()?;
        self.spawn_in(cwd.as_deref())
    }

    fn spawn_in(&self, cwd: Option<&Path>) -> io::Result<WindowsChild> {
        let exe = powershell_path()?;
        let exe = wide(exe.as_os_str())?;
        let mut command = wide(OsStr::new("powershell.exe -NoLogo"))?;
        let cwd = cwd.map(|path| wide(path.as_os_str())).transpose()?;
        let raw_job = unsafe { CreateJobObjectW(null(), null()) };
        if raw_job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                raw_job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }

        // Windows assigns the process to the job at creation, before any
        // PowerShell profile can launch children.
        let jobs: [HANDLE; 1] = [raw_job];
        let mut attrs = Attributes::new()?;
        attrs.set(
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            self.0 as *const c_void,
            size_of::<HPCON>(),
        )?;
        attrs.set(
            PROC_THREAD_ATTRIBUTE_JOB_LIST,
            jobs.as_ptr().cast(),
            size_of::<[HANDLE; 1]>(),
        )?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        startup.lpAttributeList = attrs.ptr();
        let mut process = PROCESS_INFORMATION::default();
        if unsafe {
            CreateProcessW(
                exe.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT,
                null(),
                cwd.as_ref().map_or(null(), |value| value.as_ptr()),
                &startup.StartupInfo,
                &mut process,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let _thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
        let process = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
        Ok(WindowsChild { job, process })
    }
}

impl Drop for WindowsPty {
    fn drop(&mut self) {
        unsafe { ClosePseudoConsole(self.0) };
    }
}

pub(crate) struct WindowsChild {
    job: OwnedHandle,
    process: OwnedHandle,
}

impl WindowsChild {
    pub(crate) fn close(self) -> io::Result<()> {
        let result = if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
        // Kill-on-close is also the fallback if explicit termination failed.
        drop(self.job);
        if unsafe { WaitForSingleObject(self.process.as_raw_handle(), INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    struct Terminal {
        child: WindowsChild,
        writer: File,
        console: WindowsPty,
        output: mpsc::Receiver<Vec<u8>>,
        reader: thread::JoinHandle<()>,
    }

    impl Terminal {
        fn start(try_invalid_path: bool) -> Self {
            let (console, mut reader, writer) = WindowsPty::open(24, 80).unwrap();
            let (send, output) = mpsc::channel();
            let reader = thread::spawn(move || {
                let mut buffer = [0; 4096];
                while let Ok(n @ 1..) = reader.read(&mut buffer) {
                    let _ = send.send(buffer[..n].to_vec());
                }
            });
            if try_invalid_path {
                assert!(console.spawn_in(Some(Path::new("|invalid-cwd|"))).is_err());
            }
            let child = console.spawn(None).unwrap();
            Self {
                child,
                writer,
                console,
                output,
                reader,
            }
        }

        fn marker(&mut self, command: &str, marker: &str) -> u32 {
            self.writer.write_all(command.as_bytes()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut received = Vec::new();
            loop {
                let line = self
                    .output
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("PowerShell marker was not received");
                received.extend(line);
                let text = String::from_utf8_lossy(&received);
                if let Some((_, suffix)) = text.split_once(marker) {
                    if let Some(end) = suffix.find(['\r', '\n', '\x1b']) {
                        return suffix[..end].trim().parse().expect("numeric marker");
                    }
                }
            }
        }

        fn close(self) {
            let Self {
                child,
                writer,
                console,
                output: _,
                reader,
            } = self;
            drop(writer);
            let result = child.close();
            drop(console);
            reader.join().unwrap();
            result.unwrap();
        }
    }

    #[test]
    fn native_terminal_retries_and_only_closes_its_own_process_tree() {
        let mut first = Terminal::start(true);
        let mut second = Terminal::start(false);
        let pid = first.marker(
            "Write-Output (('LAB'+'-CHILD=') + (Start-Process powershell.exe -PassThru -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60').Id)\r",
            "LAB-CHILD=",
        );
        let child = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        assert!(!child.is_null(), "open the test descendant");
        let child = unsafe { OwnedHandle::from_raw_handle(child) };
        let mut belongs = 0;
        assert_ne!(
            unsafe {
                IsProcessInJob(
                    child.as_raw_handle(),
                    first.child.job.as_raw_handle(),
                    &mut belongs,
                )
            },
            0
        );
        assert_ne!(belongs, 0, "test descendant must be in the session job");
        first.close();
        assert_eq!(
            unsafe { WaitForSingleObject(child.as_raw_handle(), 2000) },
            WAIT_OBJECT_0
        );
        let year = second.marker(
            "Write-Output (('LAB'+'-DATE=') + (Get-Date).Year)\r",
            "LAB-DATE=",
        );
        assert!((2020..=2200).contains(&year));
        second.close();
    }
}
