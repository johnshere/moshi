param(
  [Parameter(Mandatory = $true)][string]$VenvDir,
  [Parameter(Mandatory = $true)][string]$SidecarDir,
  [string]$PythonVersion = '3.12.10',
  [string]$Mirror = 'https://pypi.tuna.tsinghua.edu.cn/simple'
)
# Installs the optional Python component during setup (V-04).
#
#   1. use an existing 64-bit Python >= 3.11 when present; otherwise download the
#      official python.org installer (Authenticode verified) into
#      %LOCALAPPDATA%\moshi\python
#   2. create the sidecar venv, install sidecar/requirements.txt, fetch the model
#   3. self-check imports + model file, write sidecar/component.json
#
# ASCII only (Windows PowerShell 5.1 decodes UTF-8 without BOM as ANSI).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$msg) { Write-Output "[install-python] $msg" }

function Test-PythonExe([string]$exe) {
  if ([string]::IsNullOrWhiteSpace($exe)) { return $false }
  if (-not (Test-Path -LiteralPath $exe)) { return $false }
  $probe = & $exe -c "import sys,venv,ensurepip;print('OK%d.%d %s' % (sys.version_info[0], sys.version_info[1], sys.maxsize > 4294967296))" 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($probe)) { return $false }
  if ($probe -notmatch '^OK3\.(\d+) True') { return $false }
  return [int]$Matches[1] -ge 11
}

function Find-Python {
  $candidates = @()
  $candidates += (Join-Path $env:LOCALAPPDATA 'moshi\python\python.exe')
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  $cmd = Get-Command python3 -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  foreach ($c in $candidates) {
    if (Test-PythonExe $c) { return (Resolve-Path -LiteralPath $c).Path }
  }
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    $exe = & py -c "import sys;print(sys.executable)" 2>$null
    if (Test-PythonExe $exe) { return (Resolve-Path -LiteralPath $exe).Path }
  }
  return ''
}

function Install-Python {
  $dest = Join-Path $env:LOCALAPPDATA 'moshi\python'
  $file = "python-$PythonVersion-amd64.exe"
  $url = "https://www.python.org/ftp/python/$PythonVersion/$file"
  $tmp = Join-Path $env:TEMP ("moshi-python-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Write-Step "downloading Python $PythonVersion"
    $exe = Join-Path $tmp $file
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    $sig = Get-AuthenticodeSignature -FilePath $exe
    if ($sig.Status -ne 'Valid') { throw "Python installer signature is not valid: $($sig.Status)" }
    Write-Step 'installing Python (per-user, no PATH changes)'
    $args = @(
      '/quiet', 'InstallAllUsers=0', 'PrependPath=0', 'Include_pip=1',
      'Include_venv=1', 'Include_launcher=0', 'Include_test=0', 'Shortcuts=0',
      "TargetDir=$dest"
    )
    $proc = Start-Process -FilePath $exe -ArgumentList $args -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "Python installer failed with exit code $($proc.ExitCode)" }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
  $python = Join-Path $dest 'python.exe'
  if (-not (Test-PythonExe $python)) { throw "Python was installed but is not usable: $python" }
  return $python
}

try {
  $python = Find-Python
  if ([string]::IsNullOrWhiteSpace($python)) { $python = Install-Python }
  Write-Step "python = $python"

  if (Test-Path -LiteralPath $VenvDir) {
    Write-Step 'removing previous venv'
    Remove-Item -Recurse -Force -LiteralPath $VenvDir
  }
  Write-Step 'creating venv'
  & $python -m venv $VenvDir
  if ($LASTEXITCODE -ne 0) { throw "venv creation failed with exit code $LASTEXITCODE" }

  $venvPy = Join-Path $VenvDir 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $venvPy)) { throw "venv python not found: $venvPy" }

  Write-Step 'installing Python packages (torch / sentence-transformers / PyG; this can take several minutes)'
  & $venvPy -m pip install --disable-pip-version-check --no-input --progress-bar off `
    --timeout 60 --retries 3 -i $Mirror -r (Join-Path $SidecarDir 'requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw "pip install failed with exit code $LASTEXITCODE" }

  Write-Step 'downloading embedding model'
  & $venvPy (Join-Path $SidecarDir 'fetch_model.py')
  if ($LASTEXITCODE -ne 0) { throw "model download failed with exit code $LASTEXITCODE" }

  Write-Step 'self-check'
  & $venvPy -c "import torch, sentence_transformers, torch_geometric, win32pipe, win32file; print('imports ok')"
  if ($LASTEXITCODE -ne 0) { throw 'sidecar imports failed' }
  $model = Join-Path $SidecarDir 'models\bge-small-zh-v1.5\model.safetensors'
  if (-not (Test-Path -LiteralPath $model)) { throw "model file not found: $model" }

  $info = [ordered]@{
    component   = 'python'
    version     = 1
    python      = $python
    venv_python = $venvPy
    installed_at = (Get-Date).ToString('o')
  } | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $SidecarDir 'component.json') -Value $info -Encoding UTF8
  Write-Step 'done'
  exit 0
} catch {
  Write-Output ("[install-python] ERROR: " + $_.Exception.Message)
  exit 1
}
