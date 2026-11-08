param([Parameter(Mandatory)][string] $BundleDirectory)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable runner required.' }
$setup = @(Get-ChildItem (Join-Path $BundleDirectory 'nsis') -Filter '*-setup.exe')
if ($setup.Count -ne 1) { throw 'Expected one production NSIS installer.' }
$root = Join-Path $env:RUNNER_TEMP ('lab-m4-production-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $root 'installed'
New-Item -ItemType Directory -Path $root | Out-Null
$installer = Start-Process $setup[0].FullName -ArgumentList @('/S', "/D=$install") -Wait -PassThru
if ($installer.ExitCode -ne 0) { throw 'Production install failed.' }
$profile = Join-Path $root 'webview'
$env:TAURI_WEBVIEW_AUTOMATION = 'true'
$env:TAURI_AUTOMATION = 'true'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
$env:WEBVIEW2_USER_DATA_FOLDER = $profile
$app = Start-Process (Join-Path $install 'wraith.exe') -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 200
        $app.Refresh()
        if ($app.HasExited) { throw 'Production app exited during launch.' }
    } until ($app.MainWindowHandle -ne 0 -or [DateTime]::UtcNow -ge $deadline)
    if ($app.MainWindowHandle -eq 0) { throw 'Production window did not open.' }
    $opened = Test-NetConnection 127.0.0.1 -Port 9333 -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($opened) { throw 'Production enabled the requested DevTools endpoint.' }
    if (Test-Path (Join-Path $profile 'DevToolsActivePort')) { throw 'Production enabled a dynamic DevTools endpoint.' }
    # Exercise the installed production sidecar directly. This is not a GUI Usage assertion.
    $valid = Join-Path $root 'valid.jsonl.zst'
    $bad = Join-Path $root 'damaged.jsonl.zst'
    Copy-Item 'packages/usage-core/fixtures/synthetic/codex.jsonl.zst' $valid
    $bytes = [IO.File]::ReadAllBytes($valid)
    [IO.File]::WriteAllBytes($bad, $bytes[0..($bytes.Length - 2)])
    foreach ($path in @($valid, $bad)) {
        $request = @{version=1; requestId='production'; method='scan'; params=@{agent='codex'; path=$path; cachePath=(Join-Path $root 'cache.sqlite')}} | ConvertTo-Json -Compress
        $response = $request | & (Join-Path $install 'usage-service/node.exe') (Join-Path $install 'usage-service/main.cjs')
        if ($LASTEXITCODE -ne 0) { throw 'Installed production sidecar failed.' }
        $result = ($response | ConvertFrom-Json).result
        if ($path -eq $valid -and ($result.status -ne 'ok' -or $result.records.Count -ne 1 -or $result.records[0].input -ne 10)) { throw 'Incorrect production Usage result.' }
        if ($path -eq $bad -and ($result.status -ne 'partial' -or $result.records.Count -ne 0)) { throw 'Incorrect production partial result.' }
    }
    Write-Output 'Production NSIS smoke passed: native window, DevTools disabled, installed sidecar. GUI Usage is tested separately on an automation artifact.'
} finally {
    if (-not $app.HasExited) { $app.Kill(); $app.WaitForExit() }
}
