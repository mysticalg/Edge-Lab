@echo off
setlocal
cd /d "%~dp0"
set "EDGE_LAB_PORT=4178"
if exist "runtime\node.exe" (
  echo Starting Edge Lab. Open http://127.0.0.1:4178 in your browser.
  echo Keep this window open. Press Ctrl+C to stop.
  "runtime\node.exe" server.mjs
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js 22+ is required for a source checkout. Use the Windows ZIP for the bundled runtime.
    pause
    exit /b 1
  )
  if not exist node_modules (
    call npm ci
    if errorlevel 1 exit /b 1
  )
  if not exist dist (
    call npm run build
    if errorlevel 1 exit /b 1
  )
  echo Open http://127.0.0.1:4178 in your browser.
  node server.mjs
)
pause
