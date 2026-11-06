//! Experimental native Windows Job Object lifecycle test only.
//! No agent CLI, arbitrary command, user process, approval or sandbox handling.
#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(not(windows))]
fn main() {
    eprintln!("This synthetic test requires Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod windows_test {
    use std::ffi::{c_void, OsStr};
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use std::ptr::{null, null_mut};
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    type Handle = *mut c_void;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
    const JOB_OBJECT_BASIC_PROCESS_ID_LIST: u32 = 3;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
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
        x_count_chars: u32,
        y_count_chars: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        reserved2_count: u16,
        reserved2: *mut u8,
        std_input: Handle,
        std_output: Handle,
        std_error: Handle,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        process_id: u32,
        thread_id: u32,
    }
    #[repr(C)]
    struct BasicLimitInformation {
        process_user_time: i64,
        job_user_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }
    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }
    #[repr(C)]
    struct ProcessIdList {
        assigned: u32,
        count: u32,
        ids: [usize; 16],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: u32,
            data: *const c_void,
            length: u32,
        ) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: u32,
            data: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn IsProcessInJob(process: Handle, job: Handle, result: *mut i32) -> i32;
        fn CreateProcessW(
            application: *const u16,
            command: *mut u16,
            process_attributes: *mut c_void,
            thread_attributes: *mut c_void,
            inherit: i32,
            flags: u32,
            environment: *mut c_void,
            directory: *const u16,
            startup: *mut StartupInfoW,
            information: *mut ProcessInformation,
        ) -> i32;
        fn ResumeThread(thread: Handle) -> u32;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn GetProcessId(process: Handle) -> u32;
        fn WaitForSingleObject(object: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    struct OwnedHandle(Handle);
    impl OwnedHandle {
        fn new(value: Handle) -> io::Result<Self> {
            if value.is_null() {
                Err(io::Error::last_os_error())
            } else {
                Ok(Self(value))
            }
        }
    }
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Unrelated(Child);
    impl Drop for Unrelated {
        fn drop(&mut self) {
            let _ = self.0.wait();
        }
    }
    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }
    fn check(ok: i32) -> io::Result<()> {
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    fn create_job() -> io::Result<OwnedHandle> {
        let job = OwnedHandle::new(unsafe { CreateJobObjectW(null_mut(), null()) })?;
        let mut limits: ExtendedLimitInformation = unsafe { zeroed() };
        limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        check(unsafe {
            SetInformationJobObject(
                job.0,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                (&limits as *const ExtendedLimitInformation).cast(),
                size_of::<ExtendedLimitInformation>() as u32,
            )
        })?;
        Ok(job)
    }
    fn start_suspended(job: &OwnedHandle, signal: &std::path::Path) -> io::Result<OwnedHandle> {
        let exe = std::env::current_exe()?;
        let application = wide(exe.as_os_str());
        let mut command = wide(OsStr::new(&format!(
            "\"{}\" --synthetic-worker \"{}\"",
            exe.display(),
            signal.display()
        )));
        let mut startup: StartupInfoW = unsafe { zeroed() };
        startup.cb = size_of::<StartupInfoW>() as u32;
        let mut info: ProcessInformation = unsafe { zeroed() };
        check(unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                null_mut(),
                null_mut(),
                0,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                null_mut(),
                null(),
                &mut startup,
                &mut info,
            )
        })?;
        let process = OwnedHandle::new(info.process)?;
        let thread = OwnedHandle::new(info.thread)?;
        if let Err(error) = check(unsafe { AssignProcessToJobObject(job.0, process.0) }) {
            // This exact child was created suspended by this test, so it cannot escape.
            unsafe {
                TerminateProcess(process.0, 1);
                WaitForSingleObject(process.0, 5_000);
            }
            return Err(error);
        }
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        Ok(process)
    }
    fn job_processes(job: &OwnedHandle) -> io::Result<Vec<u32>> {
        let mut list: ProcessIdList = unsafe { zeroed() };
        check(unsafe {
            QueryInformationJobObject(
                job.0,
                JOB_OBJECT_BASIC_PROCESS_ID_LIST,
                (&mut list as *mut ProcessIdList).cast(),
                size_of::<ProcessIdList>() as u32,
                null_mut(),
            )
        })?;
        if list.count > 16 || list.assigned != list.count {
            return Err(io::Error::other("Unexpected process list"));
        }
        list.ids[..list.count as usize]
            .iter()
            .map(|id| u32::try_from(*id).map_err(|_| io::Error::other("Invalid process ID")))
            .collect()
    }
    fn wait_handle(handle: &OwnedHandle, ms: u32) -> io::Result<u32> {
        let result = unsafe { WaitForSingleObject(handle.0, ms) };
        if result == u32::MAX {
            Err(io::Error::last_os_error())
        } else {
            Ok(result)
        }
    }
    fn self_test() -> io::Result<()> {
        let exe = std::env::current_exe()?;
        let mut unrelated = Unrelated(
            Command::new(&exe)
                .arg("--synthetic-unrelated")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()?,
        );
        let job = create_job()?;
        let signal =
            std::env::temp_dir().join(format!("lab-m4-job-test-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&signal);
        let process = start_suspended(&job, &signal)?;
        let deadline = Instant::now() + Duration::from_secs(8);
        let ids = loop {
            let ids = job_processes(&job)?;
            let grandchild = std::fs::read_to_string(&signal)
                .ok()
                .and_then(|s| s.parse::<u32>().ok());
            if grandchild.is_some_and(|pid| ids.contains(&pid)) {
                break (ids, grandchild.unwrap());
            }
            if Instant::now() >= deadline {
                let worker_state = match wait_handle(&process, 0)? {
                    WAIT_OBJECT_0 => "exited",
                    WAIT_TIMEOUT => "running",
                    _ => "unexpected wait result",
                };
                return Err(io::Error::other(format!(
                    "Expected worker and grandchild; found {} job processes, worker {worker_state}",
                    ids.len()
                )));
            }
            sleep(Duration::from_millis(25));
        };
        let (ids, grandchild_id) = ids;
        let _ = std::fs::remove_file(&signal);
        let worker_id = unsafe { GetProcessId(process.0) };
        if worker_id == 0 || !ids.contains(&worker_id) || worker_id == grandchild_id {
            return Err(io::Error::other("Unexpected job membership"));
        }
        let mut unrelated_in_job = 0;
        check(unsafe {
            IsProcessInJob(
                unrelated.0.as_raw_handle().cast(),
                job.0,
                &mut unrelated_in_job,
            )
        })?;
        if unrelated_in_job != 0 {
            return Err(io::Error::other("Unrelated process is in the job"));
        }
        let mut handles = Vec::new();
        for pid in ids {
            let h = OwnedHandle::new(unsafe {
                OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
            })?;
            let mut in_job = 0;
            check(unsafe { IsProcessInJob(h.0, job.0, &mut in_job) })?;
            if in_job == 0 || wait_handle(&h, 0)? != WAIT_TIMEOUT {
                return Err(io::Error::other("Process is not active in this job"));
            }
            handles.push(h);
        }
        if unrelated.0.try_wait()?.is_some() {
            return Err(io::Error::other("Unrelated test process ended early"));
        }
        drop(job); // Last job handle: kill-on-close terminates only this job's processes.
        for handle in &handles {
            if wait_handle(handle, 5_000)? != WAIT_OBJECT_0 {
                return Err(io::Error::other("Owned descendant did not exit"));
            }
        }
        if wait_handle(&process, 0)? != WAIT_OBJECT_0 {
            return Err(io::Error::other("Worker did not exit"));
        }
        if unrelated.0.try_wait()?.is_some() {
            return Err(io::Error::other(
                "Unrelated test process did not survive STOP",
            ));
        }
        println!("PASS: suspended assignment; job close stopped worker and grandchild; unrelated process survived");
        Ok(())
    }
    pub fn main() -> io::Result<()> {
        match std::env::args().nth(1).as_deref() {
            Some("--self-test") => self_test(),
            Some("--synthetic-worker") => {
                let child = Command::new(std::env::current_exe()?)
                    .arg("--synthetic-grandchild")
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()?;
                let signal = std::env::args_os()
                    .nth(2)
                    .ok_or_else(|| io::Error::other("Missing signal path"))?;
                std::fs::write(signal, child.id().to_string())?;
                sleep(Duration::from_secs(30));
                Ok(())
            }
            Some("--synthetic-grandchild") => {
                sleep(Duration::from_secs(30));
                Ok(())
            }
            Some("--synthetic-unrelated") => {
                sleep(Duration::from_secs(10));
                Ok(())
            }
            _ => Err(io::Error::other(
                "Use --self-test; this is not a worker launcher",
            )),
        }
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = windows_test::main() {
        eprintln!("Synthetic Windows Job Object test failed: {error}");
        std::process::exit(1);
    }
}
