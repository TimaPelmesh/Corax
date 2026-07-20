@echo off
setlocal
rem Single-port HTTPS (local CA from Settings → HTTPS).
rem Stop start_all.bat first. Open https://YOUR-IP:3000 after start.
cd /d "%~dp0"

set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "CORAX_TLS_FORCE=1"
set "RELOAD=0"
set "PORT=3000"
set "HOST=0.0.0.0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm not found.
  pause
  exit /b 1
)

echo [https] build + run with TLS force on port %PORT%
echo [https] URL: https://127.0.0.1:%PORT%/  ^(or your LAN IP^)
echo.

call npm.cmd run start:prod
echo.
pause
exit /b 0
