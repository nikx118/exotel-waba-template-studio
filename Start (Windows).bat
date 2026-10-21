@echo off
rem WABA Template Studio - double-click to start (Windows 10/11).
rem Uses Node.js 18+ if it's installed. If not, downloads a private copy into .runtime\ (one time,
rem about 30 MB, no admin rights) and uses that. Nothing is installed system-wide.
setlocal
title WABA Template Studio
cd /d "%~dp0"
set "NODE_VERSION=v22.12.0"
set "LOCAL_NODE=%~dp0.runtime\node\node.exe"

where node >nul 2>nul && node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)" >nul 2>nul && (
  set "NODE=node"
  goto run
)
if exist "%LOCAL_NODE%" (
  set "NODE=%LOCAL_NODE%"
  goto run
)

echo.
echo   First run: downloading Node.js %NODE_VERSION% for this computer (one time, ~30 MB)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-node.ps1" -Version %NODE_VERSION%
if errorlevel 1 (
  echo.
  echo   Couldn't download Node.js. Check your internet connection, or install it from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)
set "NODE=%LOCAL_NODE%"

:run
"%NODE%" server.js
if errorlevel 1 (
  echo.
  echo   WABA Template Studio stopped with an error ^(see above^).
  echo.
  pause
)
