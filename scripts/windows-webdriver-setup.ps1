$ErrorActionPreference = 'Stop'
$client = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$versions = @(
    Get-ItemPropertyValue -LiteralPath "HKCU:\SOFTWARE\$client" -Name pv -ErrorAction SilentlyContinue
    Get-ItemPropertyValue -LiteralPath "HKLM:\SOFTWARE\WOW6432Node\$client" -Name pv -ErrorAction SilentlyContinue
) | Where-Object { $_ -match '^[1-9]\d*\.\d+\.\d+\.\d+$' } | Select-Object -Unique
if (@($versions).Count -ne 1) { throw 'Expected a single identifiable WebView2 runtime.' }
$runtime = @($versions)[0]
$compatible = '^Microsoft Edge WebDriver ' + [regex]::Escape(($runtime -split '\.' | Select-Object -First 3) -join '.') + '\.'
$driver = if ($env:EDGEWEBDRIVER) { Join-Path $env:EDGEWEBDRIVER 'msedgedriver.exe' }
if (-not $driver -or -not (Test-Path -LiteralPath $driver) -or (& $driver --version) -notmatch $compatible) {
    $download = Join-Path $env:RUNNER_TEMP 'lab-m4-edge-driver'
    New-Item -ItemType Directory -Path $download | Out-Null
    $zip = Join-Path $download 'driver.zip'
    Invoke-WebRequest -Uri "https://msedgedriver.microsoft.com/$runtime/edgedriver_win64.zip" -OutFile $zip -TimeoutSec 60
    Expand-Archive -LiteralPath $zip -DestinationPath $download
    $driver = Join-Path $download 'msedgedriver.exe'
}
$driverVersion = & $driver --version
if ($LASTEXITCODE -ne 0 -or $driverVersion -notmatch $compatible) {
    throw "EdgeDriver version '$driverVersion' does not match WebView2 $runtime."
}
Write-Output "WebView2 $runtime | $driverVersion"
"TAURI_NATIVE_DRIVER=$driver" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
