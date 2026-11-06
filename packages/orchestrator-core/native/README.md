# Experimental Windows STOP proof of concept

`job_stop.rs` is a synthetic lifecycle test, not an agent adapter or a sandbox.
It starts only its own executable. It creates the worker suspended, assigns the
worker to an unnamed Job Object configured with `KILL_ON_JOB_CLOSE`, then resumes
the worker. The worker launches a synthetic grandchild. The test checks the job's
process IDs and membership, closes the job handle, waits for both owned processes
to exit, and verifies a separate synthetic process remains alive and is not a
member of that job. That unrelated process exits naturally and is waited for.
If job assignment fails, the test terminates its own still-suspended child.

Run on native Windows x64 from the repository root, choosing a fresh output path:

```powershell
rustc --edition 2021 packages/orchestrator-core/native/job_stop.rs -o .lab-m4/test-tmp/job-stop-proof.exe
.\.lab-m4\test-tmp\job-stop-proof.exe --self-test
```

Job membership may be restricted by an enclosing job or system policy, in which
case the test must fail rather than fall back to an unbounded worker. This test
does not prove behavior of Codex, Grok, their launchers or existing user sessions,
nor does it implement cancellation while waiting for approval, restart recovery,
or enforcement of filesystem, network or approval policy. A job is not a sandbox.

`job_supervisor.rs` is a separate reusable lifecycle primitive, exercised by
`supervisor_test.rs`. It creates an `.exe` suspended, places it in a private
kill-on-close job before resuming, and can terminate the job with a bounded
wait for zero active processes. It is **not wired to real workers** and does
not implement stdin/stdout transport, environment filtering, workspace/network
isolation or approval enforcement. It currently inherits the supervisor's
environment. It must not be used to enable a live agent mode until these
requirements have independently been implemented and verified.

```powershell
rustc --edition 2021 packages/orchestrator-core/native/supervisor_test.rs -o .lab-m4/test-tmp/supervisor-test.exe
.\.lab-m4\test-tmp\supervisor-test.exe
```
