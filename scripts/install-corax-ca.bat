@echo off
setlocal EnableExtensions
rem Install CORAX Local CA into Windows Trusted Root.
rem Default: Current User (admin browsers).
rem Agents / GPO: run as Administrator with /machine
rem   install-corax-ca.bat /machine
rem   install-corax-ca.bat /machine C:\path\to\corax-local-ca.crt
cd /d "%~dp0.."

set "MACHINE=0"
set "CA="
:parse
if "%~1"=="" goto after_parse
if /I "%~1"=="/machine" (
  set "MACHINE=1"
  shift
  goto parse
)
if /I "%~1"=="-machine" (
  set "MACHINE=1"
  shift
  goto parse
)
set "CA=%~1"
shift
goto parse
:after_parse

if "%CA%"=="" set "CA=%~dp0..\backend\data\tls\ca.crt"
if not exist "%CA%" set "CA=%~dp0..\backend\data\tls\ca.crt"

if not exist "%CA%" (
  echo [error] CA not found: backend\data\tls\ca.crt
  echo Create it in CORAX: Settings - HTTPS - Create certificate - Download CA
  echo Or pass path: install-corax-ca.bat [/machine] C:\path\to\corax-local-ca.crt
  pause
  exit /b 1
)

echo [ca] %CA%
if "%MACHINE%"=="1" (
  echo [ca] Installing into Local Machine \ Trusted Root ^(agents / GPO^)
  echo [ca] Requires Administrator.
  echo.
  certutil -addstore Root "%CA%"
  if errorlevel 1 (
    echo [error] certutil Local Machine failed. Run elevated CMD/PowerShell.
    pause
    exit /b 1
  )
) else (
  echo [ca] Installing into Current User \ Trusted Root ^(admin browser^)
  echo.
  certutil -user -addstore Root "%CA%"
  if errorlevel 1 (
    echo.
    echo [warn] Current-user install failed. Trying Local Machine ^(may need Admin^)...
    certutil -addstore Root "%CA%"
    if errorlevel 1 (
      echo [error] certutil failed.
      pause
      exit /b 1
    )
  )
)

echo.
echo [ok] CA installed.
echo.
echo Admin PCs: close ALL Chrome/Edge windows, open https://SERVER:3000
echo Agents: use /machine or deploy via GPO to Computer Configuration \
echo   Policies \ Windows Settings \ Security Settings \ Public Key Policies \
echo   Trusted Root Certification Authorities
echo Rebuild agent ZIP with https:// after enabling HTTPS on the server.
echo.
pause
exit /b 0
