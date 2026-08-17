@echo off
setlocal EnableExtensions

REM Inventory Agent - scheduled task installer (stable).
REM REQUIRE: run this file "as Administrator".
REM Purpose: create a weekly scheduled task to run the correct agent runner (Win7 or Win10/11).

cd /d "%~dp0"

set "LOG_FILE=%TEMP%\inventory_agent_schedule.log"
echo ============================================================>>"%LOG_FILE%"
echo [%DATE% %TIME%] start: %~f0>>"%LOG_FILE%"
echo ============================================================>>"%LOG_FILE%"

REM Keep console open when launched from Explorer.
if /i not "%~1"=="console" (
  start "" cmd.exe /k call "%~fs0" console
  exit /b 0
)

REM Admin check (works on Win7+). No auto-UAC.
fltmc >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  echo ERROR: Run as Administrator is required.
  echo Tip: Right-click this file and choose "Run as administrator".
  echo [%DATE% %TIME%] admin_check_failed rc=%ERRORLEVEL%>>"%LOG_FILE%"
  pause
  exit /b 1
)
echo [%DATE% %TIME%] admin_check_ok>>"%LOG_FILE%"

set "AGENT_ROOT=%~dp0"
if "%AGENT_ROOT:~-1%"=="\" set "AGENT_ROOT=%AGENT_ROOT:~0,-1%"

set "DEFAULT_TASK_NAME=inventory_agent"
set "DEFAULT_DAY=TUE"
set "DEFAULT_TIME=12:00"

echo ============================================================
echo Inventory Agent - Schedule installer (Admin)
echo ============================================================
echo Agent folder:
echo   %AGENT_ROOT%
echo Log file:
echo   %LOG_FILE%
echo ============================================================
echo.
echo Press Enter to keep defaults.
echo.

set "TASK_NAME="
set /p TASK_NAME=Task name [%DEFAULT_TASK_NAME%] ^> 
if not defined TASK_NAME set "TASK_NAME=%DEFAULT_TASK_NAME%"
echo [%DATE% %TIME%] input TASK_NAME=%TASK_NAME%>>"%LOG_FILE%"

REM Detect OS major.minor via PowerShell to avoid parsing localized 'ver' output.
set "OS_MM="
for /f "usebackq delims=" %%v in (`powershell.exe -NoProfile -Command "$v=[Environment]::OSVersion.Version; '{0}.{1}' -f $v.Major,$v.Minor"`) do set "OS_MM=%%v"
if not defined OS_MM set "OS_MM=10.0"
echo [%DATE% %TIME%] os_mm=%OS_MM%>>"%LOG_FILE%"

set "REL_SCRIPT=win10-11\inventory_send_win10.bat"
for /f "tokens=1,2 delims=." %%a in ("%OS_MM%") do (
  set "VMAJ=%%a"
  set "VMIN=%%b"
)
if "%VMAJ%"=="6" if "%VMIN%"=="1" set "REL_SCRIPT=win7\inventory_send_win7.bat"

echo Using runner:
echo   %REL_SCRIPT%
echo [%DATE% %TIME%] rel_script=%REL_SCRIPT%>>"%LOG_FILE%"

if not exist "%AGENT_ROOT%\%REL_SCRIPT%" (
  echo ERROR: Agent runner not found:
  echo   %AGENT_ROOT%\%REL_SCRIPT%
  echo [%DATE% %TIME%] missing_runner>>"%LOG_FILE%"
  pause
  exit /b 1
)

set "DAY="
set /p DAY=Weekday [%DEFAULT_DAY%] ^> 
if not defined DAY set "DAY=%DEFAULT_DAY%"
echo [%DATE% %TIME%] input DAY=%DAY%>>"%LOG_FILE%"

set "START_TIME="
set /p START_TIME=Time HH:MM [%DEFAULT_TIME%] ^> 
if not defined START_TIME set "START_TIME=%DEFAULT_TIME%"
echo [%DATE% %TIME%] input START_TIME=%START_TIME%>>"%LOG_FILE%"

REM Task command uses pushd so UNC shares work too.
REM schtasks /TR quoting is extremely picky. Use escaped form:
REM   /TR "\"cmd.exe\" /c \"pushd \\\"<dir>\\\" ^&^& call \\\"<bat>\\\" nopause ^&^& popd\""
set "TR_CMD=\"%ComSpec%\" /c \"pushd \\\"%AGENT_ROOT%\\\" ^&^& call \\\"%REL_SCRIPT%\\\" nopause ^&^& popd\""
echo [%DATE% %TIME%] tr_cmd=%TR_CMD%>>"%LOG_FILE%"

echo.
echo Creating scheduled task:
echo   Name: %TASK_NAME%
echo   When: weekly %DAY% at %START_TIME%
echo   Run:  %AGENT_ROOT%\%REL_SCRIPT%
echo.

echo [%DATE% %TIME%] schtasks_create>>"%LOG_FILE%"
schtasks /Create /TN "%TASK_NAME%" /SC WEEKLY /D %DAY% /ST %START_TIME% /TR "%TR_CMD%" /RL HIGHEST /F 1>>"%LOG_FILE%" 2>>&1
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] schtasks_rc=%RC%>>"%LOG_FILE%"

if not "%RC%"=="0" (
  echo ERROR: schtasks failed, rc=%RC%.
  echo Check log:
  echo   %LOG_FILE%
  pause
  exit /b 1
)

echo.
echo OK: Task created. Verify:
echo   schtasks /Query /TN "%TASK_NAME%" /V /FO LIST
echo.
schtasks /Query /TN "%TASK_NAME%" /V /FO LIST
echo.
echo Done. In Task Scheduler press F5 to refresh.
pause
exit /b 0

