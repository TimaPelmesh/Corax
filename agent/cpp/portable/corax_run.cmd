@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "ERR=0"
set "EXE=%~dp0CORAX-Agent.exe"
set "CORAX_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%CORAX_PS%" set "CORAX_PS=%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"

REM ASCII-only. Do not use: start "title" (new/minimized cmd window),
REM PATH powershell.exe (WindowsApps stub flashes a second window).

echo.
echo   CORAX Agent
echo   folder: %CD%
echo.

if not exist "%EXE%" (
  echo [FAIL] CORAX-Agent.exe not found
  set "ERR=1"
  goto :done
)

REM GUI exe: run in THIS console. "start /wait" opens another window and
REM the Explorer-launched cmd appears to flash and minimize.
if /I "%~1"=="--silent" goto :wait_exe
if /I "%~1"=="--provision-only" goto :wait_exe

echo   starting CORAX-Agent.exe
echo.
"%EXE%" %*
set "ERR=%ERRORLEVEL%"
goto :done

:wait_exe
if exist "%CORAX_PS%" (
  "%CORAX_PS%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Start-Process -LiteralPath '%EXE%' -ArgumentList '%~1' -WorkingDirectory '%~dp0.' -Wait -WindowStyle Hidden"
  set "ERR=%ERRORLEVEL%"
) else (
  "%EXE%" %*
  set "ERR=%ERRORLEVEL%"
)
goto :done

:done
if not "%ERR%"=="0" (
  echo.
  echo [FAIL] exit %ERR%
  if exist "%~dp0corax-agent.log" type "%~dp0corax-agent.log"
)
if /I "%~1"=="--silent" exit /b %ERR%
if /I "%~1"=="--provision-only" exit /b %ERR%
if defined INV_NOPAUSE exit /b %ERR%
echo.
pause
endlocal & exit /b %ERR%
