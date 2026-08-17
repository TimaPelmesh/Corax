@echo off
setlocal
cd /d "%~dp0"
start "" /wait "CORAX-Agent.exe"
exit /b %errorlevel%
