param([Parameter(Mandatory)][string] $BundleDirectory)

$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Installer smoke must run on a disposable GitHub-hosted runner.'
}
if (Test-Path -LiteralPath 'apps/desktop/usage-service') {
    throw 'Developer sidecar must be absent from the installer smoke.'
}

$installers = @(Get-ChildItem -LiteralPath (Join-Path $BundleDirectory 'nsis') -File -Filter '*-setup.exe')
if ($installers.Count -ne 1) { throw 'Expected exactly one NSIS release installer.' }
$testRoot = Join-Path $env:RUNNER_TEMP ('lab-m4-package-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $testRoot 'installed'
New-Item -ItemType Directory -Path $testRoot | Out-Null

$data = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'com.wondris.labm4'
$sources = Join-Path $data 'usage'
if (Test-Path -LiteralPath $data) { throw 'The runner already has Lab-M4 application data.' }
$setup = Start-Process -FilePath $installers[0].FullName -ArgumentList @('/S', "/D=$install") -WindowStyle Hidden -Wait -PassThru
if ($setup.ExitCode -ne 0) { throw "Lab-M4 installation failed with exit $($setup.ExitCode)." }
$exe = Join-Path $install 'wraith.exe'
$sidecar = Join-Path $install 'usage-service'
foreach ($relative in @('node.exe', 'main.cjs', 'manifest.json', 'runtime.json',
                       'licenses/node-LICENSE', 'licenses/fzstd-LICENSE', 'licenses/xxhash-wasm-LICENSE.md',
                       'node_modules/sqlite3/LICENSE', 'node_modules/sqlite3/build/Release/node_sqlite3.node')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sidecar $relative) -PathType Leaf)) {
        throw "Installed sidecar resource missing: $relative"
    }
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Installed Lab-M4 executable missing.' }

$valid = Join-Path $testRoot 'valid.jsonl.zst'
$damaged = Join-Path $testRoot 'damaged.jsonl.zst'
Copy-Item -LiteralPath 'packages/usage-core/fixtures/synthetic/codex.jsonl.zst' -Destination $valid
$bytes = [IO.File]::ReadAllBytes($valid)
[IO.File]::WriteAllBytes($damaged, $bytes[0..($bytes.Length - 2)])
New-Item -ItemType Directory -Path $sources | Out-Null
@{ valid = @('codex', $valid); damaged = @('codex', $damaged) } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $sources 'sources.json') -Encoding utf8NoBOM

$env:LAB_M4_INSTALLED_EXE = $exe
node scripts/windows-webdriver-smoke.mjs
exit $LASTEXITCODE
