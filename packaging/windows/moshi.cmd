@echo off
rem moshi launcher (V-03). Uses the Node runtime downloaded by the installer when
rem present, otherwise falls back to Node on PATH. Keep this file ASCII-only:
rem batch files are decoded with the system codepage.
setlocal
set "MOSHI_ROOT=%~dp0"

if exist "%LOCALAPPDATA%\moshi\node\node.exe" (
  set "MOSHI_NODE=%LOCALAPPDATA%\moshi\node\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [moshi] Node.js 22.18+ was not found.
    echo [moshi] Re-run the moshi installer to install the missing runtime.
    exit /b 1
  )
  set "MOSHI_NODE=node"
)

"%MOSHI_NODE%" "%MOSHI_ROOT%dist\app\main.js" %*
exit /b %errorlevel%
