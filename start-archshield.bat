@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 20.19 or newer is required.
  echo Install Node.js, then double-click this file again.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm included.
  pause
  exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 20 || (major === 20 && minor < 19)) { console.error('Node.js 20.19 or newer is required.'); process.exit(1); }"
if errorlevel 1 (
  pause
  exit /b 1
)

if not exist "node_modules\.bin\tsc.cmd" (
  echo First run: installing ArchShield dependencies...
  call npm ci
  if errorlevel 1 (
    echo Dependency installation failed. Check your connection and try again.
    pause
    exit /b 1
  )
)

echo Starting ArchShield. Keep this window open while using the browser.
call npm run ui
echo.
echo ArchShield has stopped.
pause
