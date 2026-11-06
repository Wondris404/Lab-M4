# Lab-M4

Based on Wraith (Wondris404/Wraith, commit 700f170). See [Wraith license](licenses/Wraith-LICENSE.txt).

Work in progress. Usage parsers are preserved in `packages/usage-core`.

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
