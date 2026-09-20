@echo off
REM Open inbound TCP 3000 (web dev) and 3001 (API / agents) on THIS computer.
REM Right-click - Run as administrator.

call :ensure_rule "Inventory Web 3000" 3000
call :ensure_rule "Inventory API 3001" 3001
goto :end

:ensure_rule
netsh advfirewall firewall show rule name=%~1 >nul 2>&1
if %ERRORLEVEL%==0 (
  echo Rule %~1 already exists.
  exit /b 0
)

netsh advfirewall firewall add rule name=%~1 dir=in action=allow protocol=TCP localport=%~2 >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo FAILED to add %~1. Run this file as Administrator.
  exit /b 1
)
echo OK: inbound TCP %~2 allowed.
exit /b 0

:end
pause
