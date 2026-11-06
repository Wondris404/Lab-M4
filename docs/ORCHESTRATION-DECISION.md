# Orchestration integration: open decision

The candidate is [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator).
No upstream code has been imported. An exact source commit, its NOTICE and the
licenses of the required modules and dependencies have not been verified; the
upstream project must not be adopted on the strength of its README alone.
GitHub access from the current execution environment is blocked. Do not bypass
that restriction to fetch the candidate.

The installed Codex CLI 0.166.0 can generate app-server schemas locally; those
schemas describe command, file-change and permission approval requests. Some
command details are nullable, and a file-change approval requires correlation
with other events to identify the actual scope. The schemas do not prove that
every protected action triggers an approval or that an OS boundary is enforced.
Grok Build 1.0.70 advertises `agent --no-leader stdio`, but local help does not
establish the approval request/response, cancellation semantics, or the
enforcement of the required protected-operation exceptions. `--always-approve`
is not an acceptable substitute.

Until those contracts, native Windows process isolation and lifecycle are
verified, the live adapters must remain disabled. Worktrees are not sandboxes;
synthetic approvals and simulated STOP do not secure child processes. The
fake-only harness in `packages/orchestrator-core` is a deterministic test of
state transitions and persists synthetic state only; it does not execute agents,
review actual diffs, measure real usage, enforce budgets or kill process trees.

Once permitted GitHub access is restored, inspect a specific immutable upstream
commit and its licenses, delegation/result/review/correction/cancellation paths,
Grok executable and transport, Codex manager support, headless integration and
native Windows behavior. Compare supported integration with a narrowly scoped
extraction. Record source links, notices and modifications before importing any
code. A real adapter remains unsupported until its exact approval handshake and
enforceable boundaries pass synthetic and native Windows tests.
