# Lab-M4

Based on Wraith (Wondris404/Wraith, commit 700f170). See [Wraith license](licenses/Wraith-LICENSE.txt).

Version 1.0.0 release preparation; not a published release. Usage parsers are
preserved in `packages/usage-core`. See [release scope and validation](docs/RELEASE-1.0.0.md).

The terminal font picker includes Google Fonts. On startup the app attempts to
load their stylesheet from `fonts.googleapis.com` and font files from
`fonts.gstatic.com`; these requests require Internet access and reveal the
client's network address to Google. When unavailable, the terminal uses its
configured fallback font. The Windows WebView2 behavior is not yet verified.

## Usage from the existing terminal

From the repository root, scan a source explicitly chosen by the user:

```powershell
pnpm.cmd usage codex packages/usage-core/fixtures/synthetic/codex.jsonl.zst
pnpm.cmd usage grok-build <path-to-jsonl>
```

The project-local command compiles the current Usage parser into the ignored
`.lab-m4/usage-cli` build directory and prints aggregate JSON. Token counts are
decimal strings; cached input and reasoning are subsets of input and output,
respectively. It does not print session IDs or individual records. Cost is
labelled `unknown`, not subscription billing or a fabricated zero. A partial
scan has status `partial`; the underlying `node scripts/usage-cli.mjs` exits
with code 2 (pnpm can report its own failure code). Unreadable sources exit
with code 1.
Only use sources you are authorised to read. OpenCode may be unavailable when
safe read-only access cannot be guaranteed.

## Windows release

Use the official Node.js 24.22.2 Windows archive with its `LICENSE` file
alongside `node.exe`. Put that directory first on `PATH` for the build and
enable Corepack shims there. The sidecar packs the executable and license from
the same distribution.

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd package:usage-sidecar
pnpm.cmd test
pnpm.cmd tauri build --bundles nsis
```

CI runs the terminal smoke separately from the installed Usage smoke. The
installed test takes the NSIS artifact from the same workflow, runs on a clean
Windows runner without a developer sidecar, and restricts the app's `PATH`
to Windows System32. It scans valid and damaged synthetic Usage archives.

## Usage privacy

Usage reads only the sources you explicitly select and keeps normalized metrics
and its cache on this computer. It uses Tauri IPC and a bundled stdio sidecar,
not an HTTP service. The Usage process denies network, child-process and worker
APIs before loading parsers and receives no inherited provider credentials from
the desktop. This is defense in depth against accidental egress, not an OS
sandbox for hostile native code. AI CLI networking and optional dictation outside
Usage are separate features; the entire app is not advertised as offline.

CSV is an explicit local download containing your real metrics. It is not
uploaded automatically, but manually sharing it discloses those metrics.
Session identifiers in the local cache are pseudonymized, not fully anonymous.
Keep source logs, caches, exports and credentials out of Git. Only reviewed
synthetic fixtures belong in this repository. Run `pnpm check:release-privacy`
before publishing; its secret patterns do not prove arbitrary text is anonymous.
Personal diagnostic counts and workstation paths were redacted from the current
documentation. Existing commits, other branches and cached GitHub views are not
erased by a normal pull request; no history rewrite has been performed.
