# Fake orchestration lifecycle

This is a synthetic state-machine test harness. It does not invoke Codex or Grok,
enforce a sandbox, or report real tokens or costs. A worker attempt writes one
file in a throwaway git worktree, then the review reads that `git diff` and the
exit code of `check.mjs`. Attempt number alone cannot accept a result. Live
adapters are not implemented and a start without `--fake` fails closed. The CLI
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
