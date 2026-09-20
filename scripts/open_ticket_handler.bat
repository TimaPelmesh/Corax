@echo off
setlocal

rem Arguments: CORAX base URL and fixed inventory hostname.
if not "%~1"=="" set "CORAX_URL=%~1"
set "CORAX_PC=%~2"
if "%CORAX_URL%"=="" (
  echo Usage: open_ticket_handler.bat http://CORAX-SERVER:3000 PC-023
  echo.
  echo Create a shortcut with the CORAX server URL and the fixed PC name.
  echo Opens AI ticket handler form: /h#pc=HOSTNAME
  pause
  exit /b 2
)
if "%CORAX_PC%"=="" (
  echo Missing fixed PC name.
  pause
  exit /b 2
)

if "%CORAX_URL:~-1%"=="/" set "CORAX_URL=%CORAX_URL:~0,-1%"

start "" "%CORAX_URL%/h#pc=%CORAX_PC%"
