use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io;
use std::mem::{offset_of, size_of, size_of_val};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{self, Path, PathBuf};
use std::ptr::{null, null_mut};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, JobObjectBasicAccountingInformation,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, OpenProcess,
    UpdateProcThreadAttribute, WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

pub(crate) struct WindowsPty(HPCON);

pub(crate) fn pipe() -> io::Result<(File, File)> {
    let (mut reader, mut writer) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut reader, &mut writer, null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (File::from_raw_handle(reader), File::from_raw_handle(writer)) })
}

pub(crate) fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
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

pub(crate) struct Attributes(Vec<usize>);

impl Attributes {
    pub(crate) fn new() -> io::Result<Self> {
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

    pub(crate) fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.0.as_mut_ptr().cast()
    }

    pub(crate) fn set(&mut self, key: u32, value: *const c_void, size: usize) -> io::Result<()> {
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
    #[cfg(test)]
    pub(crate) fn open(rows: i16, cols: i16) -> io::Result<(Self, File, File)> {
        let (console_input, writer) = pipe()?;
        let (reader, console_output) = pipe()?;
        let console = Self::from_pipes(rows, cols, console_input, console_output)?;
        Ok((console, reader, writer))
    }

    pub(crate) fn from_pipes(
        rows: i16,
        cols: i16,
        console_input: File,
        console_output: File,
    ) -> io::Result<Self> {
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
        Ok(Self(console))
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

    pub(crate) fn working_directory(cwd: Option<&str>) -> io::Result<Option<PathBuf>> {
        cwd.filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(PathBuf::from)
                    .filter(|path| path.is_dir())
            })
            .map(path::absolute)
            .transpose()
    }

    #[cfg(test)]
    pub(crate) fn spawn(&self, cwd: Option<&str>) -> io::Result<WindowsChild> {
        self.spawn_in(Self::working_directory(cwd)?.as_deref())
    }

    pub(crate) fn spawn_in(&self, cwd: Option<&Path>) -> io::Result<WindowsChild> {
        let exe = powershell_path()?;
        let exe = wide(exe.as_os_str())?;
        let mut command = wide(OsStr::new("powershell.exe -NoLogo"))?;
        let cwd = cwd.map(|path| wide(path.as_os_str())).transpose()?;
        let job = WindowsJob::new()?;

        // Windows assigns the process to the job at creation, before any
        // PowerShell profile can launch children.
        let jobs: [HANDLE; 1] = [job.as_raw_handle()];
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
    job: WindowsJob,
    pub(crate) process: OwnedHandle,
}

impl WindowsChild {
    #[cfg(test)]
    pub(crate) fn close(self) -> io::Result<()> {
        self.close_by(Instant::now() + Duration::from_secs(2))
    }

    pub(crate) fn close_by(self, deadline: Instant) -> io::Result<()> {
        self.job.terminate()?;
        wait_process_by(&self.process, deadline)?;
        self.job.wait_empty(deadline)
    }
}

pub(crate) struct WindowsJob(OwnedHandle);

impl WindowsJob {
    pub(crate) fn new() -> io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub(crate) fn as_raw_handle(&self) -> HANDLE {
        self.0.as_raw_handle()
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn member_handles(&self) -> io::Result<Vec<OwnedHandle>> {
        const HEADER_WORDS: usize =
            offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) / size_of::<usize>();
        let mut capacity = 16;
        let pids = loop {
            if capacity > 4096 {
                return Err(io::Error::other(
                    "Too many terminal processes to verify shutdown",
                ));
            }
            let mut storage = vec![0usize; HEADER_WORDS + capacity];
            let list = storage
                .as_mut_ptr()
                .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            if unsafe {
                QueryInformationJobObject(
                    self.as_raw_handle(),
                    JobObjectBasicProcessIdList,
                    list.cast(),
                    size_of_val(storage.as_slice()) as u32,
                    null_mut(),
                )
            } == 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_MORE_DATA as i32) {
                    capacity *= 2;
                    continue;
                }
                return Err(error);
            }
            let assigned = unsafe { (*list).NumberOfAssignedProcesses } as usize;
            let copied = unsafe { (*list).NumberOfProcessIdsInList } as usize;
            if copied > capacity {
                return Err(io::Error::other("Invalid terminal job process list"));
            }
            if copied < assigned {
                capacity = (capacity * 2).max(assigned);
                continue;
            }
            storage.truncate(HEADER_WORDS + copied);
            break storage;
        };
        let mut handles = Vec::new();
        for &pid in &pids[HEADER_WORDS..] {
            let pid = u32::try_from(pid).map_err(io::Error::other)?;
            let process = unsafe {
                OpenProcess(
                    PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    pid,
                )
            };
            if process.is_null() {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                    continue; // The process exited after the snapshot.
                }
                return Err(error);
            }
            let process = unsafe { OwnedHandle::from_raw_handle(process) };
            let mut belongs = 0;
            if unsafe {
                IsProcessInJob(process.as_raw_handle(), self.as_raw_handle(), &mut belongs)
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if belongs != 0 {
                handles.push(process);
            }
        }
        Ok(handles)
    }

    pub(crate) fn wait_empty(&self, deadline: Instant) -> io::Result<()> {
        loop {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            if unsafe {
                QueryInformationJobObject(
                    self.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if accounting.ActiveProcesses == 0 {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Terminal job did not exit",
                ));
            }
            thread::sleep(remaining.min(Duration::from_millis(10)));
        }
    }
}

pub(crate) fn wait_process_by(process: &OwnedHandle, deadline: Instant) -> io::Result<()> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    match unsafe { WaitForSingleObject(process.as_raw_handle(), remaining.as_millis() as u32) } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Terminal process did not exit",
        )),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
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

    #[test]
    fn close_wait_returns_while_the_process_is_still_alive() {
        let terminal = Terminal::start(false);
        let error = wait_process_by(
            &terminal.child.process,
            Instant::now() + Duration::from_millis(1),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        terminal.close();
    }

    #[test]
    fn close_returns_while_powershell_is_printing() {
        let mut terminal = Terminal::start(false);
        terminal
            .writer
            .write_all(b"1..20000 | ForEach-Object { \"LAB-M4-OUTPUT-$_\" }\r")
            .unwrap();
        terminal
            .output
            .recv_timeout(Duration::from_secs(8))
            .expect("PowerShell produced output");
        let started = Instant::now();
        terminal.close();
        assert!(started.elapsed() < Duration::from_secs(8));
    }

    #[test]
    fn close_cancels_a_blocked_conpty_input_write() {
        #[link(name = "ntdll")]
        extern "system" {
            fn NtSuspendProcess(process: HANDLE) -> i32;
        }
        let terminal = Terminal::start(false);
        assert_eq!(
            unsafe { NtSuspendProcess(terminal.child.process.as_raw_handle()) },
            0,
            "suspend PowerShell so it stops reading ConPTY input"
        );
        let input = crate::pty_input::PtyInput::start_blocking_for_test(terminal.writer).unwrap();
        let mut blocked = input.enqueue("x".repeat(256 * 1024)).unwrap();
        thread::sleep(Duration::from_millis(300));
        assert!(
            blocked.try_recv().is_err(),
            "the ConPTY input write is still blocked"
        );
        let started = Instant::now();
        drop(input);
        assert!(started.elapsed() < Duration::from_secs(3));
        let started = Instant::now();
        terminal.child.close().unwrap();
        drop(terminal.console);
        terminal.reader.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(8));
    }
}
