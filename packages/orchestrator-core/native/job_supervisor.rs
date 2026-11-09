//! Windows process lifecycle primitive. This is NOT a sandbox or approval policy.
//! No live adapter uses this module yet. Never treat successful job assignment as
//! authorization to launch an unrestricted coding agent.
#![cfg(windows)]

use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::thread::sleep;
use std::time::{Duration, Instant};

type Handle = *mut c_void;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x400;
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
const STARTF_USESTDHANDLES: u32 = 0x100;
const HANDLE_FLAG_INHERIT: u32 = 1;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000d;
const KILL_ON_CLOSE: u32 = 0x2000;
const EXTENDED_LIMIT_INFORMATION: u32 = 9;
const BASIC_ACCOUNTING_INFORMATION: u32 = 1;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_TIMEOUT: u32 = 258;

#[repr(C)]
struct StartupInfoW {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_chars: u32,
    y_chars: u32,
    fill: u32,
    flags: u32,
    show: u16,
    reserved_len: u16,
    reserved2: *mut u8,
    stdin: Handle,
    stdout: Handle,
    stderr: Handle,
}
#[repr(C)]
struct StartupInfoExW {
    startup: StartupInfoW,
    attributes: *mut c_void,
}
#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    pid: u32,
    tid: u32,
}
#[repr(C)]
struct BasicLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    min_working: usize,
    max_working: usize,
    active_limit: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}
#[repr(C)]
struct IoCounters {
    reads: u64,
    writes: u64,
    others: u64,
    read_bytes: u64,
    write_bytes: u64,
    other_bytes: u64,
}
#[repr(C)]
struct ExtendedLimits {
    basic: BasicLimits,
    io: IoCounters,
    process_memory: usize,
    job_memory: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}
#[repr(C)]
struct Accounting {
    total_user: i64,
    total_kernel: i64,
    period_user: i64,
    period_kernel: i64,
    page_faults: u32,
    total_processes: u32,
    active_processes: u32,
    terminated_processes: u32,
}
#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: u32, data: *const c_void, len: u32) -> i32;
    fn QueryInformationJobObject(
        job: Handle,
        class: u32,
        data: *mut c_void,
        len: u32,
        returned: *mut u32,
    ) -> i32;
    fn TerminateJobObject(job: Handle, code: u32) -> i32;
    fn CreatePipe(read: *mut Handle, write: *mut Handle, attrs: *const c_void, size: u32) -> i32;
    fn SetHandleInformation(handle: Handle, mask: u32, flags: u32) -> i32;
    fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        key: usize,
        value: *const c_void,
        size: usize,
        previous: *mut c_void,
        returned: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        app: *const u16,
        command: *mut u16,
        process_attrs: *mut c_void,
        thread_attrs: *mut c_void,
        inherit: i32,
        flags: u32,
        env: *mut c_void,
        cwd: *const u16,
        startup: *mut StartupInfoW,
        information: *mut ProcessInformation,
    ) -> i32;
    fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
    fn CloseHandle(handle: Handle) -> i32;
}
struct Owned(Handle);
impl Owned {
    fn new(handle: Handle) -> io::Result<Self> {
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn check(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut out: Vec<u16> = value.encode_wide().collect();
    if out.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "NUL in argument",
        ));
    }
    out.push(0);
    Ok(out)
}

// Quote one argument using the Windows CRT argv convention. No shell is used.
fn quote(value: &OsStr) -> io::Result<Vec<u16>> {
    let source = wide(value)?;
    let mut out = vec![b'"' as u16];
    let mut slashes = 0;
    for &ch in &source[..source.len() - 1] {
        if ch == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        if ch == b'"' as u16 {
            out.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat_n(b'\\' as u16, slashes));
        }
        out.push(ch);
        slashes = 0;
    }
    out.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    out.push(b'"' as u16);
    Ok(out)
}

fn pipe() -> io::Result<(File, File)> {
    let (mut reader, mut writer) = (null_mut(), null_mut());
    check(unsafe { CreatePipe(&mut reader, &mut writer, null(), 0) })?;
    // Successful CreatePipe returns two owned handles, initially non-inheritable.
    Ok(unsafe { (File::from_raw_handle(reader), File::from_raw_handle(writer)) })
}

fn environment_block(environment: &[(&str, &OsStr)]) -> io::Result<Vec<u16>> {
    let mut entries = Vec::with_capacity(environment.len());
    for &(name, value) in environment {
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid environment name",
            ));
        }
        entries.push((name.to_ascii_uppercase(), value));
    }
    entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    if entries.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Duplicate environment name",
        ));
    }
    let mut block = Vec::new();
    for (name, value) in entries {
        block.extend(name.encode_utf16());
        block.push(b'=' as u16);
        block.extend(wide(value)?);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

struct Attributes(Vec<usize>);
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut size = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
        check(unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut size)
        })?;
        Ok(Self(storage))
    }
    fn ptr(&mut self) -> *mut c_void {
        self.0.as_mut_ptr().cast()
    }
    fn set(&mut self, key: usize, handles: &[Handle]) -> io::Result<()> {
        check(unsafe {
            UpdateProcThreadAttribute(
                self.ptr(),
                0,
                key,
                handles.as_ptr().cast(),
                std::mem::size_of_val(handles),
                null_mut(),
                null_mut(),
            )
        })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.ptr()) };
    }
}

pub(crate) struct ChildPipes {
    pub(crate) stdin: File,
    pub(crate) stdout: File,
    pub(crate) stderr: File,
}

/// Owns exactly one job and its initial process. Dropping it closes the last
/// supervisor job handle, triggering kill-on-close.
pub(crate) struct Supervised {
    job: Owned,
    process: Owned,
}
impl Supervised {
    /// Low-level lifecycle only. Callers must separately enforce authorization,
    /// workspace/network boundaries, input redaction and agent protocol policy.
    /// The caller supplies the complete child environment and owns pipe I/O deadlines.
    pub(crate) fn spawn(
        exe: &Path,
        args: &[&OsStr],
        cwd: &Path,
        environment: &[(&str, &OsStr)],
    ) -> io::Result<(Self, ChildPipes)> {
        if !exe.is_absolute()
            || !cwd.is_absolute()
            || !exe
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Absolute executable and cwd required",
            ));
        }
        let app = wide(exe.as_os_str())?;
        let directory = wide(cwd.as_os_str())?;
        let mut environment = environment_block(environment)?;
        let mut command = quote(exe.as_os_str())?;
        for arg in args {
            command.push(b' ' as u16);
            command.extend(quote(arg)?);
        }
        command.push(0);
        let job = Owned::new(unsafe { CreateJobObjectW(null_mut(), null()) })?;
        let mut limits: ExtendedLimits = unsafe { zeroed() };
        limits.basic.flags = KILL_ON_CLOSE;
        check(unsafe {
            SetInformationJobObject(
                job.0,
                EXTENDED_LIMIT_INFORMATION,
                (&limits as *const ExtendedLimits).cast(),
                size_of::<ExtendedLimits>() as u32,
            )
        })?;
        let (child_in, stdin) = pipe()?;
        let (stdout, child_out) = pipe()?;
        let (stderr, child_err) = pipe()?;
        let child_handles = [
            child_in.as_raw_handle(),
            child_out.as_raw_handle(),
            child_err.as_raw_handle(),
        ];
        for handle in child_handles {
            check(unsafe {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
            })?;
        }
        let jobs = [job.0];
        let mut attributes = Attributes::new()?;
        attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &child_handles)?;
        // Atomic assignment also avoids a suspended orphan if the host dies in spawn.
        attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
        let mut startup: StartupInfoExW = unsafe { zeroed() };
        startup.startup.cb = size_of::<StartupInfoExW>() as u32;
        startup.startup.flags = STARTF_USESTDHANDLES;
        startup.startup.stdin = child_handles[0];
        startup.startup.stdout = child_handles[1];
        startup.startup.stderr = child_handles[2];
        startup.attributes = attributes.ptr();
        let mut info: ProcessInformation = unsafe { zeroed() };
        check(unsafe {
            CreateProcessW(
                app.as_ptr(),
                command.as_mut_ptr(),
                null_mut(),
                null_mut(),
                1,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_mut_ptr().cast(),
                directory.as_ptr(),
                &mut startup.startup,
                &mut info,
            )
        })?;
        let process = Owned::new(info.process)?;
        let _thread = Owned::new(info.thread)?;
        Ok((
            Self { job, process },
            ChildPipes {
                stdin,
                stdout,
                stderr,
            },
        ))
    }
    pub(crate) fn running(&self) -> io::Result<bool> {
        match unsafe { WaitForSingleObject(self.process.0, 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }
    pub(crate) fn active_count(&self) -> io::Result<u32> {
        let mut info: Accounting = unsafe { zeroed() };
        check(unsafe {
            QueryInformationJobObject(
                self.job.0,
                BASIC_ACCOUNTING_INFORMATION,
                (&mut info as *mut Accounting).cast(),
                size_of::<Accounting>() as u32,
                null_mut(),
            )
        })?;
        Ok(info.active_processes)
    }
    #[allow(dead_code)] // Membership is queried by the native regression.
    pub(crate) fn contains_process(&self, process: *mut c_void) -> io::Result<bool> {
        #[link(name = "kernel32")]
        extern "system" {
            fn IsProcessInJob(process: Handle, job: Handle, result: *mut i32) -> i32;
        }
        let mut result = 0;
        check(unsafe { IsProcessInJob(process, self.job.0, &mut result) })?;
        Ok(result != 0)
    }
    /// Stop only this job and confirm that no processes remain, with a deadline.
    pub(crate) fn stop(&self, timeout: Duration) -> io::Result<()> {
        check(unsafe { TerminateJobObject(self.job.0, 1) })?;
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid timeout"))?;
        loop {
            if self.active_count()? == 0 && !self.running()? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Owned processes did not exit",
                ));
            }
            sleep(Duration::from_millis(20));
        }
    }
}
