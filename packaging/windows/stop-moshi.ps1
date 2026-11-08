param(
  [string]$LockFile = (Join-Path $env:USERPROFILE '.moshi\daemon.lock'),
  [int]$TimeoutSec = 15
)
# Gracefully stops a running moshi daemon (V-03 installer/uninstaller).
# ASCII only (PowerShell 5.1 codepage).
$ErrorActionPreference = 'SilentlyContinue'

# Honor a custom [storage] data_dir in ~/.moshi/config.toml (~ expands to the profile).
$configFile = Join-Path $env:USERPROFILE '.moshi\config.toml'
if (Test-Path $configFile) {
  $m = Select-String -Path $configFile -Pattern '^\s*data_dir\s*=\s*"([^"]+)"' | Select-Object -First 1
  if ($m) {
    $dir = $m.Matches[0].Groups[1].Value.Replace('~', $env:USERPROFILE).Replace('/', '\')
    $LockFile = Join-Path $dir 'daemon.lock'
  }
}

if (-not (Test-Path $LockFile)) { exit 0 }
try {
  $info = Get-Content $LockFile -Raw | ConvertFrom-Json
} catch { exit 0 }
if (-not $info -or -not $info.pid) { exit 0 }

try {
  $headers = @{ 'x-moshi-token' = [string]$info.token }
  Invoke-RestMethod -Method Post -TimeoutSec 5 -Headers $headers `
    -Uri ("http://127.0.0.1:" + $info.port + "/api/control/stop") | Out-Null
} catch { }

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)) { exit 0 }
  Start-Sleep -Milliseconds 300
}

# Last resort: the daemon did not answer /stop. SQLite WAL recovers on next start.
Stop-Process -Id $info.pid -Force -ErrorAction SilentlyContinue
exit 0
