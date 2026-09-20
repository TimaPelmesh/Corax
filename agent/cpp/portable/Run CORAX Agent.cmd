@echo off
cd /d "%~dp0"
echo CORAX Agent
call "%~dp0corax_run.cmd" %*
if defined INV_NOPAUSE exit /b %ERRORLEVEL%
if /I "%~1"=="--silent" exit /b %ERRORLEVEL%
exit /b %ERRORLEVEL%
