//! Keep the potentially unbounded ConPTY close operation in the session's job.
use crate::windows_pty::{pipe, wait_process_by, wide, Attributes, WindowsJob, WindowsPty};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read, Write};
use std::mem::{size_of, size_of_val};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    DuplicateHandle, GetHandleInformation, DUPLICATE_SAME_ACCESS, ERROR_BROKEN_PIPE, ERROR_NO_DATA,
    HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{GetFileType, ReadFile, WriteFile, FILE_TYPE_PIPE};
use windows_sys::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS,
    PAGE_READWRITE,
};
use windows_sys::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_NOWAIT};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateProcessW, GetCurrentProcess, GetExitCodeProcess, SetEvent,
    WaitForMultipleObjects, WaitForSingleObject, CREATE_NO_WINDOW, EXTENDED_STARTUPINFO_PRESENT,
    INFINITE, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

const HOST_ARG: &str = "--lab-m4-pty-host";
pub(crate) const CLEANUP_LIMIT: Duration = Duration::from_secs(3);
const GRACE: Duration = Duration::from_millis(300);
const BOOTSTRAP_HANDLES: usize = 6;

fn own(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn duplicate(handle: HANDLE, target: HANDLE, inherit: bool) -> io::Result<HANDLE> {
    let mut result = null_mut();
    let process = unsafe { GetCurrentProcess() };
    if unsafe {
        DuplicateHandle(
            process,
            handle,
            target,
            &mut result,
            0,
            inherit.into(),
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(result)
}

fn handle_flags(handle: HANDLE) -> io::Result<u32> {
    let mut flags = 0;
    if handle.is_null()
        || handle == INVALID_HANDLE_VALUE
        || unsafe { GetHandleInformation(handle, &mut flags) } == 0
    {
        return Err(io::Error::other("Invalid terminal host handle"));
    }
    Ok(flags)
}

fn event(manual: bool) -> io::Result<OwnedHandle> {
    own(unsafe { CreateEventW(null(), manual.into(), 0, null()) })
}

fn signal(event: &OwnedHandle) -> io::Result<()> {
    if unsafe { SetEvent(event.as_raw_handle()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// Only the app's ends are nonblocking. ConPTY retains synchronous endpoints.
pub(crate) struct HostPipe(File);

impl AsRawHandle for HostPipe {
    fn as_raw_handle(&self) -> HANDLE {
        self.0.as_raw_handle()
    }
}

impl HostPipe {
    fn new(file: File) -> io::Result<Self> {
        if unsafe { SetNamedPipeHandleState(file.as_raw_handle(), &PIPE_NOWAIT, null(), null()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(file))
    }
}

impl Read for HostPipe {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let mut read = 0;
        if unsafe {
            ReadFile(
                self.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len().min(u32::MAX as usize) as u32,
                &mut read,
                null_mut(),
            )
        } != 0
        {
            return Ok(read as usize);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_NO_DATA) => Err(io::ErrorKind::WouldBlock.into()),
            Some(ERROR_BROKEN_PIPE) => Ok(0),
            _ => Err(error),
        }
    }
}

impl Write for HostPipe {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let mut written = 0;
        // A nonblocking byte pipe may reject a write larger than its buffer.
        let count = buffer.len().min(4096) as u32;
        if unsafe {
            WriteFile(
                self.as_raw_handle(),
                buffer.as_ptr(),
                count,
                &mut written,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if written == 0 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Dimensions(MEMORY_MAPPED_VIEW_ADDRESS);

// The mapping is page-aligned, retained by this object, and the shared word
// is accessed atomically by both processes.
unsafe impl Send for Dimensions {}
unsafe impl Sync for Dimensions {}

impl Dimensions {
    fn map(handle: &OwnedHandle) -> io::Result<Self> {
        let view = unsafe { MapViewOfFile(handle.as_raw_handle(), FILE_MAP_WRITE, 0, 0, 4) };
        if view.Value.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(view))
    }

    fn word(&self) -> &AtomicU32 {
        unsafe { AtomicU32::from_ptr(self.0.Value.cast()) }
    }

    fn set(&self, cols: u16, rows: u16) -> io::Result<()> {
        if !(1..=i16::MAX as u16).contains(&cols) || !(1..=i16::MAX as u16).contains(&rows) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid terminal dimensions",
            ));
        }
        self.word()
            .store(u32::from(cols) | (u32::from(rows) << 16), Ordering::Release);
        Ok(())
    }

    fn get(&self) -> (u16, u16) {
        let size = self.word().load(Ordering::Acquire);
        (size as u16, (size >> 16) as u16)
    }
}

impl Drop for Dimensions {
    fn drop(&mut self) {
        unsafe { UnmapViewOfFile(self.0) };
    }
}

pub(crate) struct WindowsPtyHost {
    job: WindowsJob,
    process: OwnedHandle,
    stop: OwnedHandle,
    resize: OwnedHandle,
    dimensions: Dimensions,
    stop_requested: OnceLock<(Instant, io::Result<Vec<OwnedHandle>>)>,
    forced_members: OnceLock<io::Result<Vec<OwnedHandle>>>,
}

impl WindowsPtyHost {
    pub(crate) fn start(
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
    ) -> io::Result<(Self, HostPipe, HostPipe)> {
        Self::start_at(&std::env::current_exe()?, cols, rows, cwd)
    }

    pub(crate) fn start_at(
        executable: &Path,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
    ) -> io::Result<(Self, HostPipe, HostPipe)> {
        if !executable.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Terminal host executable must be absolute",
            ));
        }
        let (console_input, writer) = pipe()?;
        let (reader, console_output) = pipe()?;
        let (bootstrap, bootstrap_writer) = pipe()?;
        let mut bootstrap_writer = HostPipe::new(bootstrap_writer)?;
        let reader = HostPipe::new(reader)?;
        let writer = HostPipe::new(writer)?;
        let ready = event(true)?;
        let stop = event(true)?;
        let resize = event(false)?;
        let mapping = own(unsafe {
            CreateFileMappingW(INVALID_HANDLE_VALUE, null(), PAGE_READWRITE, 0, 4, null())
        })?;
        let dimensions = Dimensions::map(&mapping)?;
        dimensions.set(cols, rows)?;
        let job = WindowsJob::new()?;
        let directory = WindowsPty::working_directory(cwd)?
            .map(|path| wide(path.as_os_str()))
            .transpose()?;
        let executable = wide(executable.as_os_str())?;
        // The read-only bootstrap is the only inheritable handle in the app.
        // A concurrent unrelated spawn cannot inherit either ConPTY endpoint.
        let inherited = own(duplicate(
            bootstrap.as_raw_handle(),
            unsafe { GetCurrentProcess() },
            true,
        )?)?;
        let handles = [inherited.as_raw_handle()];
        let command = format!("wraith {HOST_ARG} {}", handles[0] as usize);
        let mut command = wide(OsStr::new(&command))?;
        let jobs = [job.as_raw_handle()];
        let mut attrs = Attributes::new()?;
        attrs.set(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            handles.as_ptr().cast(),
            size_of_val(&handles),
        )?;
        attrs.set(
            PROC_THREAD_ATTRIBUTE_JOB_LIST,
            jobs.as_ptr().cast(),
            size_of_val(&jobs),
        )?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        startup.lpAttributeList = attrs.ptr();
        let mut info = PROCESS_INFORMATION::default();
        if unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                null(),
                directory.as_ref().map_or(null(), |path| path.as_ptr()),
                &startup.StartupInfo,
                &mut info,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let _thread = own(info.hThread)?;
        let process = own(info.hProcess)?;
        drop(inherited);
        drop(bootstrap);
        let host = Self {
            job,
            process,
            stop,
            resize,
            dimensions,
            stop_requested: OnceLock::new(),
            forced_members: OnceLock::new(),
        };
        let startup = (|| {
            let mut payload = [0; BOOTSTRAP_HANDLES * size_of::<usize>()];
            for (handle, field) in [
                console_input.as_raw_handle(),
                console_output.as_raw_handle(),
                mapping.as_raw_handle(),
                ready.as_raw_handle(),
                host.stop.as_raw_handle(),
                host.resize.as_raw_handle(),
            ]
            .into_iter()
            .zip(payload.chunks_exact_mut(size_of::<usize>()))
            {
                // DuplicateHandle returns a value in the target process. The job
                // releases it if startup fails before the broker can take ownership.
                let target_handle = duplicate(handle, host.process.as_raw_handle(), false)?;
                field.copy_from_slice(&(target_handle as usize).to_le_bytes());
            }
            bootstrap_writer.write_all(&payload)
        })();
        drop(bootstrap_writer);
        drop(console_input);
        drop(console_output);
        if let Err(error) = startup.and_then(|()| host.wait_ready(&ready)) {
            if let Err(cleanup) = host.close_by(Instant::now() + CLEANUP_LIMIT) {
                return Err(io::Error::other(format!(
                    "{error}; startup cleanup failed: {cleanup}"
                )));
            }
            return Err(error);
        }
        Ok((host, reader, writer))
    }

    fn wait_ready(&self, ready: &OwnedHandle) -> io::Result<()> {
        let process = self.process.as_raw_handle();
        let startup = [ready.as_raw_handle(), process];
        match unsafe { WaitForMultipleObjects(2, startup.as_ptr(), 0, 5000) } {
            WAIT_OBJECT_0 if unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Terminal host did not become ready",
            )),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(process, &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Err(io::Error::other(format!(
                    "Terminal host exited during startup ({code})"
                )))
            }
        }
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        self.dimensions.set(cols, rows)?;
        signal(&self.resize)
    }

    pub(crate) fn request_stop(&self) -> io::Result<()> {
        // Accounting can reach zero before the process handles are signalled.
        self.stop_requested
            .get_or_init(|| (Instant::now(), self.job.member_handles()));
        signal(&self.stop)
    }

    pub(crate) fn stop_by(&self, deadline: Instant) -> io::Result<()> {
        let signalled = self.request_stop().is_ok();
        let stop_requested = self
            .stop_requested
            .get()
            .map(|(start, _)| *start)
            .unwrap_or_else(Instant::now);
        let graceful = deadline
            .min(stop_requested + GRACE)
            .saturating_duration_since(Instant::now());
        let exited = signalled
            && unsafe {
                WaitForSingleObject(self.process.as_raw_handle(), graceful.as_millis() as u32)
            } == WAIT_OBJECT_0;
        if !exited || self.job.wait_empty(Instant::now()).is_err() {
            self.forced_members
                .get_or_init(|| self.job.member_handles());
            self.job.terminate()?;
        }
        Ok(())
    }

    pub(crate) fn wait_closed_by(self, deadline: Instant) -> io::Result<()> {
        self.job.wait_empty(deadline)?;
        wait_process_by(&self.process, deadline)?;
        let graceful = self.stop_requested.get().map(|(_, members)| members);
        for snapshot in [graceful, self.forced_members.get()].into_iter().flatten() {
            for process in snapshot
                .as_ref()
                .map_err(|error| io::Error::other(error.to_string()))?
            {
                wait_process_by(process, deadline)?;
            }
        }
        Ok(())
    }

    pub(crate) fn close_by(self, deadline: Instant) -> io::Result<()> {
        self.stop_by(deadline)?;
        self.wait_closed_by(deadline)
    }

    #[cfg(test)]
    #[allow(dead_code)] // The integration test includes this module.
    pub(crate) fn process_handle(&self) -> HANDLE {
        self.process.as_raw_handle()
    }

    #[cfg(test)]
    #[allow(dead_code)] // The integration test includes this module.
    pub(crate) fn job_handle(&self) -> HANDLE {
        self.job.as_raw_handle()
    }
}

pub(crate) fn maybe_run() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(HOST_ARG)) {
        return None;
    }
    Some(if run(args).is_ok() { 0 } else { 1 })
}

fn run(args: impl Iterator<Item = std::ffi::OsString>) -> io::Result<()> {
    let mut args = args;
    let bootstrap =
        args.next()
            .and_then(|value| value.to_str()?.parse::<usize>().ok())
            .ok_or_else(|| io::Error::other("Missing terminal host bootstrap"))? as HANDLE;
    if args.next().is_some()
        || handle_flags(bootstrap)? & HANDLE_FLAG_INHERIT == 0
        || unsafe { GetFileType(bootstrap) } != FILE_TYPE_PIPE
    {
        return Err(io::Error::other("Invalid terminal host arguments"));
    }
    let mut bootstrap = unsafe { File::from_raw_handle(bootstrap) };
    let mut payload = [0; BOOTSTRAP_HANDLES * size_of::<usize>()];
    bootstrap.read_exact(&mut payload)?;
    let mut handles = [null_mut(); BOOTSTRAP_HANDLES];
    for (index, bytes) in payload.chunks_exact(size_of::<usize>()).enumerate() {
        let mut raw = [0; size_of::<usize>()];
        raw.copy_from_slice(bytes);
        let handle = usize::from_le_bytes(raw) as HANDLE;
        if handles[..index].contains(&handle) || handle_flags(handle)? & HANDLE_FLAG_INHERIT != 0 {
            return Err(io::Error::other("Invalid terminal host bootstrap handle"));
        }
        handles[index] = handle;
    }
    drop(bootstrap);
    let [input, output, mapping, ready, stop, resize] = handles;
    if [input, output]
        .into_iter()
        .any(|handle| unsafe { GetFileType(handle) } != FILE_TYPE_PIPE)
    {
        return Err(io::Error::other("Invalid terminal host pipe"));
    }
    let input = unsafe { File::from_raw_handle(input) };
    let output = unsafe { File::from_raw_handle(output) };
    let mapping = own(mapping)?;
    let ready = own(ready)?;
    let stop = own(stop)?;
    let resize = own(resize)?;
    let dimensions = Dimensions::map(&mapping)?;
    let (cols, rows) = dimensions.get();
    let console = WindowsPty::from_pipes(rows as i16, cols as i16, input, output)?;
    let child = console.spawn_in(None)?;
    signal(&ready)?;
    let events = [
        stop.as_raw_handle(),
        child.process.as_raw_handle(),
        resize.as_raw_handle(),
    ];
    loop {
        let event = unsafe { WaitForMultipleObjects(3, events.as_ptr(), 0, INFINITE) };
        match event {
            WAIT_OBJECT_0 => break,
            value if value == WAIT_OBJECT_0 + 1 => break,
            value if value == WAIT_OBJECT_0 + 2 => {
                let (cols, rows) = dimensions.get();
                let _ = console.resize(cols, rows);
            }
            _ => return Err(io::Error::last_os_error()),
        }
    }
    child.close_by(Instant::now() + GRACE)?;
    drop(console);
    Ok(())
}
