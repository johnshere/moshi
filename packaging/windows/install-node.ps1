param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Dest = (Join-Path $env:LOCALAPPDATA 'moshi\node'),
  [string]$Mirror = 'https://nodejs.org/dist'
)
# Downloads the official Node.js Windows x64 zip, verifies it against
# SHASUMS256.txt, and replaces $Dest. ASCII only (PowerShell 5.1 codepage).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$zipName = "node-v$Version-win-x64.zip"
$base = "$Mirror/v$Version"
$tmp = Join-Path $env:TEMP ("moshi-node-" + $Version + "-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  Write-Output "[install-node] downloading $zipName"
  $zip = Join-Path $tmp $zipName
  Invoke-WebRequest -Uri "$base/$zipName" -OutFile $zip -UseBasicParsing

  Write-Output '[install-node] verifying SHA256'
  $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $line = @($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($zipName))\s*$" }) | Select-Object -First 1
  if (-not $line) { throw "SHASUMS256.txt has no entry for $zipName" }
  $expected = ($line.Trim() -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash
  if ($actual -ne $expected.ToUpperInvariant()) {
    throw "SHA256 mismatch for $zipName"
  }

  Write-Output '[install-node] extracting'
  $extract = Join-Path $tmp 'extract'
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  $src = Join-Path $extract "node-v$Version-win-x64"
  if (-not (Test-Path (Join-Path $src 'node.exe'))) { throw "zip does not contain node.exe" }

  $parent = Split-Path -Parent $Dest
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $old = "$Dest.old"
  Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue
  if (Test-Path $Dest) { Move-Item -LiteralPath $Dest -Destination $old }
  Copy-Item -LiteralPath $src -Destination $Dest -Recurse -Force
  Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue

  $installed = (& (Join-Path $Dest 'node.exe') --version).Trim()
  if ([string]::IsNullOrWhiteSpace($installed)) { throw "installed node.exe did not report a version" }
  Write-Output "[install-node] installed $installed"
  Set-Content -Path (Join-Path $Dest 'version.txt') -Value $installed -Encoding ASCII
  exit 0
} catch {
  Write-Output ("[install-node] ERROR: " + $_.Exception.Message)
  exit 1
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
