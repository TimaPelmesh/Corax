@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-CORAXScheduledTask.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed. Run this file as Administrator.
  pause
  exit /b 1
)
echo.
echo CORAX Agent scheduled task installed.
pause
