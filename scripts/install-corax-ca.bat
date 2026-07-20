@echo off
setlocal EnableExtensions
rem Install CORAX Local CA into Windows Trusted Root (Current User).
rem Run this on EACH admin PC. Then fully quit Chrome/Edge and reopen.
cd /d "%~dp0.."

set "CA=%~dp0..\backend\data\tls\ca.crt"
if not exist "%CA%" set "CA=%~dp0..\backend\data\tls\ca.crt"

if not exist "%CA%" (
  echo [error] CA not found: backend\data\tls\ca.crt
  echo Create it in CORAX: Settings - HTTPS - Create certificate - Download CA
  echo Or copy corax-local-ca.crt here and pass path:
  echo   install-corax-ca.bat C:\path\to\corax-local-ca.crt
  if not "%~1"=="" set "CA=%~1"
)

if not "%~1"=="" set "CA=%~1"

if not exist "%CA%" (
  echo [error] File not found: %CA%
  pause
  exit /b 1
)

echo [ca] Installing into Current User \ Trusted Root Certification Authorities
echo [ca] %CA%
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

echo.
echo [ok] CA installed.
echo 1^) Close ALL Chrome/Edge windows ^(check tray^).
echo 2^) Open https://192.168.x.x:3000 again.
echo 3^) In cert viewer hierarchy, CORAX Local CA must NOT be red/untrusted.
echo.
pause
exit /b 0
