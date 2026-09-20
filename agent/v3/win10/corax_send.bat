@echo off
setlocal EnableExtensions
set "ERR=0"
set "CORAX_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%CORAX_PS%" set "CORAX_PS=%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"

REM ASCII-only. Use System32 powershell, never PATH powershell.exe
REM (WindowsApps alias opens a new minimized window and this cmd vanishes).

cd /d "%~dp0"
if defined CORAX_HIDDEN set "INV_NOPAUSE=1"
if not defined CORAX_HIDDEN title CORAX AGENT

if not defined CORAX_HIDDEN (
  echo.
  echo   CORAX Agent
  echo   folder: %CD%
  echo.
)

if /i "%~1"=="nopause" set "INV_NOPAUSE=1"
if defined CORAX_HIDDEN set "INV_NOPAUSE=1"

if exist "%CORAX_PS%" goto :have_ps
echo [BAT] ERROR: PowerShell not found:
echo        %CORAX_PS%
set "ERR=1"
goto :done
:have_ps

if exist "%~dp0agent_env.bat" call "%~dp0agent_env.bat"
if defined INVENTORY_SERVER goto :have_env
for %%I in ("%~dp0..") do set "CORAX_PARENT=%%~fI"
if exist "%CORAX_PARENT%\agent_env.bat" call "%CORAX_PARENT%\agent_env.bat"
:have_env

if /i not "%~1"=="nopause" if not "%~1"=="" echo %~1 | findstr /I /C:"http://" /C:"https://">NUL && set "INVENTORY_SERVER=%~1"

if defined INVENTORY_SERVER goto :have_server
echo [BAT] ERROR: INVENTORY_SERVER is not set. Use the panel ZIP, file agent_env.bat.
set "ERR=2"
goto :done
:have_server

if defined AGENT_TOKEN goto :have_token
echo [BAT] ERROR: AGENT_TOKEN is not set. Use agent_env.bat from admin bundle.
set "ERR=2"
goto :done
:have_token

if not defined CORAX_HIDDEN (
  echo   TARGET  %INVENTORY_SERVER%
  echo   START   %DATE% %TIME%
  echo.
)

if exist "%~dp0InventoryClient.ps1" goto :have_client
echo  [FAIL] InventoryClient.ps1 not found in %~dp0
set "ERR=1"
goto :done
:have_client

REM Stay in THIS console only for corax_send.bat visible.
REM Default and Task Scheduler: WindowStyle Hidden, no console.
if defined INV_NOPAUSE (
  "%CORAX_PS%" -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0InventoryClient.ps1"
) else (
  "%CORAX_PS%" -NoProfile -NoLogo -WindowStyle Normal -ExecutionPolicy Bypass -File "%~dp0InventoryClient.ps1"
)
set "ERR=%ERRORLEVEL%"

if not "%ERR%"=="0" goto :status_fail
if not defined CORAX_HIDDEN echo   STATUS  OK
goto :done
:status_fail
if not defined CORAX_HIDDEN (
  echo   STATUS  FAILED code %ERR%
  echo   See corax-agent.log in this folder and %%TEMP%%\corax-agent.log
)

:done
if defined INV_NOPAUSE goto :leave
if defined CORAX_INNER goto :leave
echo.
pause
:leave
endlocal & exit /b %ERR%
