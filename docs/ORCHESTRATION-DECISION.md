# Orchestration integration decision

## Upstream

We inspected the Apache-2.0 tree at
[OrchestratorInc/agent-orchestrator 8bf3684](https://github.com/OrchestratorInc/agent-orchestrator/tree/8bf36847091d0fe2767a199f95b8f6f48ccc35db).
There is no NOTICE file in that tree. Its adapters depend on the Go backend and
the ACP Go SDK. The Windows ACP transport uses a PID-based taskkill of the
tree and falls back to terminating the root process. The backend would bring
an additional backend and still require Lab-M4's Windows job ownership and
approval enforcement. Lab-M4 uses its own native process supervision and
keeps provider integration scoped to its two CLIs. No upstream code was copied.

- [License](https://github.com/OrchestratorInc/agent-orchestrator/blob/8bf36847091d0fe2767a199f95b8f6f48ccc35db/LICENSE)
- [Backend dependencies](https://github.com/OrchestratorInc/agent-orchestrator/blob/8bf36847091d0fe2767a199f95b8f6f48ccc35db/backend/go.mod)
- [Windows ACP transport](https://github.com/OrchestratorInc/agent-orchestrator/blob/8bf36847091d0fe2767a199f95b8f6f48ccc35db/backend/internal/adapters/chatdriver/acp/process_windows.go)

## Verified on Windows

The native supervisor assigns the CLI to a private Job Object during creation,
provides an explicit environment and connects three separate pipes. The native
regression exercises a blocked input write and an owned grandchild while an
unrelated process survives. See [native tests](../packages/orchestrator-core/native/README.md).

A protocol smoke in empty profiles used the same supervisor:

- Codex CLI 0.166.0 accepted app-server initialization and reported that
  authentication was required from account/read with token refresh disabled.
  STOP took the owned job from three active processes to zero.
- Grok Build 1.0.77 accepted ACP v1 initialization, advertised grok.com as its
  sole auth method, and refused session/new with JSON-RPC error -32000. STOP
  took the owned job from two active processes to zero. The xAI example also
  describes cached_token and xai.api_key for eligible profiles.

The smoke made no login, model turn, filesystem tool or approval request.
The available authentication for an isolated live run remains unverified.

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Grok Build headless and ACP](https://docs.x.ai/build/cli/headless-scripting)
- [Grok Build sandbox](https://docs.x.ai/build/features/sandbox)

## Live-mode gate

App Server schemas describe command, file-change and permission approvals.
Some command details are optional and a file-change approval must be tied to
the actual changes in the corresponding events. ACP approval handling and
CLI permission modes need an enforcement test on Windows. Job membership
controls process lifetime. Workspace and network access require their own
controls.

The integration must validate operation scope before allowing any change.
The manager needs the actual diff and host-run test results from the isolated
worker workspace. Live mode also needs a bounded protocol transport, recovery
that never silently replays changes, and a smoke with existing authorized CLI
access. The fake lifecycle command continues to expose synthetic state only.
