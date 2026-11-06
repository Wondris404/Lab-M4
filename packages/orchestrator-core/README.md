# Fake orchestration lifecycle

This is a synthetic state-machine test harness. It does not invoke Codex or Grok,
execute commands, create worktrees, review a real diff, enforce a sandbox, report
real tokens or costs, or terminate a Windows process tree. Live adapters are not
implemented and a start without `--fake` fails closed. It is not an orchestrator
for real project work.

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
approval, simulates a worker result after approval, and simulates a manager review;
the first review requests one correction. Every new approval has a fresh ID.
The fixed synthetic artifacts are not derived from repository contents. The
figures in `budget` are synthetic and say nothing about subscription billing or
actual spend. State is stored under `.lab-m4/orchestration-fake/`; sessions are
left in place. A stale lock after an interrupted write fails closed and requires
manual investigation. Concurrent access and crash durability have not been
verified beyond the tests. No claim is made about real approval enforcement.
