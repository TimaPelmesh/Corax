@echo off
setlocal EnableExtensions
REM Update scripts from a newly extracted ZIP folder. KEEPS agent_env.bat
REM (URL + token). Same idea as Linux: never unzip -o over a live install
REM without excluding env.
REM
REM Usage: update_scripts.bat C:\temp\corax-agent-windows-extracted

if "%~1"=="" (
  echo Usage: update_scripts.bat ^<extracted-new-zip-folder^>
  echo Keeps agent_env.bat in %~dp0
  exit /b 2
)
set "SRC=%~f1"
set "DST=%~dp0"
if not exist "%SRC%\corax_send.bat" (
  echo ERROR: %SRC%\corax_send.bat not found
  exit /b 1
)
if not exist "%SRC%\win10\corax_send.bat" (
  echo ERROR: not a unified Windows agent ZIP
  exit /b 1
)
echo Updating scripts in %DST%
echo Keeping agent_env.bat
xcopy /E /Y /I "%SRC%\win10" "%DST%win10\" >NUL
xcopy /E /Y /I "%SRC%\win7" "%DST%win7\" >NUL
copy /Y "%SRC%\corax_send.bat" "%DST%corax_send.bat" >NUL
if exist "%SRC%\register_scheduled_task.ps1" copy /Y "%SRC%\register_scheduled_task.ps1" "%DST%register_scheduled_task.ps1" >NUL
if exist "%SRC%\README_DEPLOY.txt" copy /Y "%SRC%\README_DEPLOY.txt" "%DST%README_DEPLOY.txt" >NUL
if exist "%SRC%\update_scripts.bat" copy /Y "%SRC%\update_scripts.bat" "%DST%update_scripts.bat" >NUL
echo Done. agent_env.bat was not replaced.
exit /b 0
