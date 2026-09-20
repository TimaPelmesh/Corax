@echo off
setlocal EnableExtensions
title CORAX FULL AUDIT
cd /d "%~dp0"

REM Manual full Windows audit launcher.
REM Double-click -> asks for elevation (UAC) and opens ONE audit window.
REM
REM Server URL and token can be:
REM   1) set here (uncomment lines below),
REM   2) passed as the first argument (http/https URL),
REM   3) typed in the console when prompted.

REM set "INVENTORY_SERVER=http://192.168.1.10:3001"
REM set "AGENT_TOKEN=<TOKEN>"

REM ---- Admin check (output suppressed, no "Access denied" noise) ----
fltmc >nul 2>&1
if not "%errorlevel%"=="0" goto :elevate
goto :run

:elevate
echo.
echo   Administrator rights are required.
echo   A UAC prompt will appear - confirm it to open the audit window.
echo.
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -ErrorAction Stop } catch { Write-Host '  Elevation was declined or is unavailable.' -ForegroundColor Yellow; [void](Read-Host '  Press Enter to exit') }"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs -ErrorAction Stop } catch { Write-Host '  Elevation was declined or is unavailable.' -ForegroundColor Yellow; [void](Read-Host '  Press Enter to exit') }"
)
endlocal & exit /b 0

:run
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

REM First argument that looks like http(s):// is treated as the server URL.
echo %~1 | findstr /I /R "^http:// ^https://">NUL
if "%ERRORLEVEL%"=="0" set "INVENTORY_SERVER=%~1"

if not exist "%~dp0Corax-FullAudit.ps1" (
  echo [FAIL] Corax-FullAudit.ps1 not found next to this .bat
  pause
  endlocal & exit /b 1
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Corax-FullAudit.ps1"
set "ERR=%ERRORLEVEL%"

echo.
pause
endlocal & exit /b %ERR%
