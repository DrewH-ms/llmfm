@echo off
REM Double-clickable launcher: checks Node, installs hooks on first run, opens the dashboard.
setlocal
title LLMFM
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo LLMFM needs Node 24 or newer, and Node was not found on this machine.
  echo.
  echo Install it from https://nodejs.org/ and run this again.
  start "" https://nodejs.org/
  goto fail
)

for /f "tokens=1 delims=." %%v in ('node --version') do set "NODEMAJOR=%%v"
set "NODEMAJOR=%NODEMAJOR:v=%"
if %NODEMAJOR% LSS 24 (
  node --version
  echo The line above is the Node this machine has. LLMFM needs 24 or newer, because it
  echo runs TypeScript directly instead of building it.
  echo.
  echo Upgrade from https://nodejs.org/ and run this again.
  goto fail
)

if not exist "node_modules\@tonejs\midi\" (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo This copy is missing its dependencies and npm was not found to fetch them.
    echo Download the release zip instead, which ships them: https://github.com/DrewH-ms/llmfm/releases/latest
    goto fail
  )
  echo Fetching dependencies, once only...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Dependencies failed to install.
    goto fail
  )
)

set "HOOKHOME=%COPILOT_HOME%"
if not defined HOOKHOME set "HOOKHOME=%USERPROFILE%\.copilot"
if not exist "%HOOKHOME%\hooks\llmfm.json" (
  echo Installing the Copilot CLI hooks, once only...
  node bin\llmfm.ts install
  if errorlevel 1 goto fail
  echo.
  echo Hooks installed. Open a new Copilot CLI session to be heard: sessions load hooks
  echo once at start, so terminals that are already open will not report.
  echo.
)

node bin\llmfm.ts %*
if errorlevel 1 goto fail
endlocal
exit /b 0

:fail
echo.
echo Press any key to close.
pause >nul
endlocal
exit /b 1
