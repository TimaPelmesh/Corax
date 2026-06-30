@echo off
setlocal EnableExtensions
set "ERR=0"

REM CORAX Agent - Windows 10/11 launcher.
cd /d "%~dp0"
title CORAX AGENT
color 0A

if /i "%~1"=="nopause" set "INV_NOPAUSE=1"

if not defined INV_NOPAUSE if exist "%~dp0corax_splash.ps1" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0corax_splash.ps1"
)

if exist "%~dp0agent_env.bat" (
  call "%~dp0agent_env.bat"
) else (
  echo [BAT] WARN: agent_env.bat not found. Set INVENTORY_SERVER and AGENT_TOKEN.
)

if not defined INVENTORY_SERVER (
  echo %~1 | findstr /I /R "^http:// ^https://">NUL
  if "%ERRORLEVEL%"=="0" set "INVENTORY_SERVER=%~1"
)
if not defined INVENTORY_SERVER set "INVENTORY_SERVER=http://127.0.0.1:3001"

if not defined AGENT_TOKEN (
  echo [BAT] ERROR: AGENT_TOKEN is not set. Use agent_env.bat from admin bundle.
  set "ERR=2"
  goto :done
)

echo.
echo  // CORAX AGENT --------------------------------------------
echo  // TARGET    %INVENTORY_SERVER%
echo  // START     %DATE% %TIME%
echo  // -------------------------------------------------------
echo.

if not exist "%~dp0InventoryClient.ps1" (
  echo  [FAIL] InventoryClient.ps1 not found in %~dp0
  set "ERR=1"
  goto :done
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0InventoryClient.ps1"
set "ERR=%ERRORLEVEL%"

echo.
if "%ERR%"=="0" (
  echo  // STATUS  OK
) else (
  echo  // STATUS  FAILED code %ERR%
)

:done
if not defined INV_NOPAUSE pause
endlocal & exit /b %ERR%
