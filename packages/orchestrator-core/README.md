# Fake orchestration lifecycle

This is a synthetic state-machine test harness. It does not invoke Codex or Grok,
enforce a sandbox, or report real tokens or costs. A worker attempt writes one
file in a throwaway git worktree, then the review reads that `git diff` and the
exit code of `check.mjs`. Attempt number alone cannot accept a result. This
synthetic CLI requires `--fake` for a start and fails closed without it. The CLI
does not spawn a process; its stop cancels fake state only. OS STOP is confirmed
only by `stopShippedTransport` on the shipped Windows transport binary, which
rejects a Node peer. It is not an orchestrator for real project work.

From the repository root on Windows:

```powershell
node --test packages/orchestrator-core/tests/lifecycle.test.mjs packages/orchestrator-core/tests/cli.test.mjs
node packages/orchestrator-core/src/cli.mjs start --fake
node packages/orchestrator-core/src/cli.mjs step <session-id>
node packages/orchestrator-core/src/cli.mjs status <session-id>
node packages/orchestrator-core/src/cli.mjs approve <session-id> <approval-id>
node packages/orchestrator-core/src/cli.mjs deny <session-id> <approval-id>
node packages/orchestrator-core/src/cli.mjs stop <session-id>
node packages/orchestrator-core/src/cli.mjs resume <session-id>
```

`list`, `events` and `budget` also expose the synthetic state. `step` requests an
approval, runs the synthetic attempt in a new temporary worktree, and reviews
the captured diff and test exit. The first attempt fails its check and is
repaired once; a passing corrected diff is accepted. A second failing result is
not accepted. Every new approval has a fresh ID. The synthetic file is not taken
from this repository. The
figures in `budget` are synthetic and say nothing about subscription billing or
actual spend. State is stored under `.lab-m4/orchestration-fake/`; sessions are
left in place. A stale lock after an interrupted write fails closed and requires
manual investigation. Concurrent access and crash durability have not been
verified beyond the tests. No claim is made about real approval enforcement.

## Windows orchestration

Open **Orchestrátor** below **Usage**. Choose a project folder, one to twelve
UTF-8 files, and the models for the manager and workers. The panel shows
the exact approval currently required and the resulting diff, test evidence,
and available usage. **STOP** cancels the run and the app waits for Windows to
confirm cleanup of its process tree.

The Windows integration was verified with Codex and Gemini 3.1 Flash-Lite
through OpenCode 1.18.29 using an existing Google connection.

The terminal entry point `pnpm orchestrator:plan <config.json>` runs a manager
and two to eight worker slots using existing CLI authentication. Supply a JSON object
with `transport` (absolute path to the built `agent_transport.exe`), `task`
(text), `manager`, and `workers`. The manager and each worker entry take
`provider` (`codex`, `grok`, or `opencode`), `executable` (absolute path to the CLI exe),
and an optional `model` identifier.

Review the manager's task list in the terminal and type `yes` to start the
workers. Independent tasks can run concurrently in separate Windows jobs.
Dependent tasks wait for the required proposals. Ctrl+C signals all in-flight
turns and cleanup is reported only when the transport confirms it.

Add `project` (an absolute local folder path) and `files` (one to twelve
UTF-8 files, up to 24 KiB combined) to propose actual changes. Use paths relative
to the repository root or, for a regular folder, to the selected directory.
The plan lists the assigned paths. Once approved, each worker receives its
assigned file contents. An accessible Git repository uses the latest commit.
A folder without a usable Git commit uses the selected files from disk as
the baseline in a temporary Git workspace. This also works if Git refuses the
source repository due to its owner. The manager receives the resulting diffs for
review. Lab-M4 writes proposals in separate detached worktrees in a temporary
workspace, reports overlapping files and records `git diff --check` results.
The output includes the workspace path for inspection. It does not merge any
changes into the source repository. Dependent proposals use the same base
commit and receive completed prerequisite changes only for files assigned to
the dependent worker.

With `check` set to `{ "executable": "<absolute .exe path>", "args": [] }`,
the CLI shows the exact command and eligible diffs for a second approval.
Approved tests run with the user's permissions in separate copies of the
worker proposals. The manager sees exit results and whether a result is
unavailable. Tests can execute code from the proposed files. For a regular
folder, the worktree contains only the files selected for the run. The manager can
request one correction round for a failed diff check or test. Corrections
require approval and stay separate from the original proposals. Rerunning
tests on corrected files requires a fresh approval. When worker proposals
overlap, approve sharing the conflicting files with the manager. Review the
manager's reconciliation and the combined diff, then approve the candidate and
its tests separately. This creates a detached worktree. Merging into the source
repository remains a manual decision.
