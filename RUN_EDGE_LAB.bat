@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js and run this launcher again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing Edge Lab dependencies...
  call npm install
  if errorlevel 1 (pause & exit /b 1)
)
start "" "http://127.0.0.1:5178"
call npm run dev
