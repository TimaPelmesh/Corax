@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "ERR=0"

REM CORAX Windows agent dispatcher (ASCII-only: Win7 cmd).
REM Never call PATH powershell.exe: the WindowsApps stub opens a new
REM minimized window and this console looks like it vanished.

if /i "%~1"=="visible" set "CORAX_VISIBLE=1"
if /i "%~2"=="visible" set "CORAX_VISIBLE=1"
if /i "%~3"=="visible" set "CORAX_VISIBLE=1"
if /i "%~1"=="hidden" set "CORAX_HIDDEN=1"
if /i "%~2"=="hidden" set "CORAX_HIDDEN=1"
if /i "%~1"=="nopause" set "INV_NOPAUSE=1"
if /i "%~2"=="nopause" set "INV_NOPAUSE=1"
if defined CORAX_HIDDEN set "INV_NOPAUSE=1"

REM Manual double-click: wait until inventory finishes, then show last-run status.
REM Scheduled / VBS (CORAX_HIDDEN): no window at all.
REM Debug with a full console: corax_send.bat visible
if not defined CORAX_VISIBLE if not defined CORAX_HIDDEN (
  if exist "%~dp0corax_send_silent.vbs" (
    echo.
    echo   CORAX Agent
    echo   Collecting inventory. This window closes when finished.
    echo   Later scheduled runs stay hidden.
    echo.
    wscript.exe //B //Nologo "%~dp0corax_send_silent.vbs"
    set "ERR=!ERRORLEVEL!"
    echo.
    if exist "%~dp0corax-last-run.txt" (
      type "%~dp0corax-last-run.txt"
    ) else (
      echo   No corax-last-run.txt yet — collection did not start.
      echo   See corax-agent.log in this folder and %%TEMP%%\corax-agent.log
    )
    echo.
    if not defined INV_NOPAUSE timeout /t 8 /nobreak >NUL
    exit /b !ERR!
  )
)

set "INV_SCRIPT_DIR=%~dp0"
set "INV_SELF=%~f0"
set "INV_MAP_DRIVE="
set "INV_UNC_DIR="

if not defined CORAX_HIDDEN (
  echo.
  echo   CORAX Agent
  echo.
)

echo %INV_SCRIPT_DIR% | findstr /B "\\\\">NUL
if "%ERRORLEVEL%"=="0" set "INV_UNC_DIR=%INV_SCRIPT_DIR%"
if not defined INV_UNC_DIR (
  echo %INV_SELF% | findstr /B "\\\\">NUL
  if "%ERRORLEVEL%"=="0" (
    for %%P in ("%INV_SELF%") do set "INV_UNC_DIR=%%~dpP"
  )
)

if defined INV_UNC_DIR (
  set "INV_UNC=!INV_UNC_DIR!"
  set "INV_UNC=!INV_UNC:~2!"
  for /f "tokens=1,2,* delims=\\" %%A in ("!INV_UNC!") do (
    set "INV_UNC_HOST=%%A"
    set "INV_UNC_SHARE=%%B"
    set "INV_UNC_REST=%%C"
  )
  if defined INV_UNC_HOST if defined INV_UNC_SHARE (
    for %%D in (Z Y X W V U T S R Q P O N M L K J I H G F E D) do (
      if not exist "%%D:\NUL" (
        net use %%D: "\\!INV_UNC_HOST!\!INV_UNC_SHARE!" /persistent:no >NUL 2>&1
        if "!ERRORLEVEL!"=="0" (
          set "INV_MAP_DRIVE=%%D:"
          goto :mapped_ok
        )
      )
    )
  )
)
:mapped_ok
if defined INV_MAP_DRIVE (
  cd /d "%INV_MAP_DRIVE%\!INV_UNC_REST!" >NUL 2>&1
  if errorlevel 1 cd /d "%INV_MAP_DRIVE%\" >NUL 2>&1
) else (
  cd /d "%~dp0"
)

if /i "%~1"=="nopause" set "INV_NOPAUSE=1"
if defined CORAX_HIDDEN set "INV_NOPAUSE=1"

if not defined CORAX_HIDDEN title CORAX AGENT

if not "%CORAX_AGENT_ALLOW_IN_SOURCE%"=="1" (
  if exist "%~dp0docker-compose.yml" goto :refuse_tree
  if exist "%~dp0..\docker-compose.yml" goto :refuse_tree
  if exist "%~dp0..\..\docker-compose.yml" goto :refuse_tree
  if exist "%~dp0run.py" if exist "%~dp0backend" goto :refuse_tree
  if exist "%~dp0..\run.py" if exist "%~dp0..\backend" goto :refuse_tree
  if exist "%~dp0..\..\run.py" if exist "%~dp0..\..\backend" goto :refuse_tree
  if exist "%~dp0backend\.env" goto :refuse_tree
  if exist "%~dp0..\backend\.env" goto :refuse_tree
)

if exist "%~dp0agent_env.bat" (
  call "%~dp0agent_env.bat"
) else (
  echo [BAT] ERROR: agent_env.bat not found.
  echo        Download ZIP from CORAX panel -^> Agent build. Do not run git templates.
  set "ERR=2"
  goto :done
)

if "%~1"=="" goto :have_url_arg_skip
echo %~1 | findstr /I /R "^http:// ^https://">NUL
if "%ERRORLEVEL%"=="0" set "INVENTORY_SERVER=%~1"
:have_url_arg_skip

call :is_placeholder "%INVENTORY_SERVER%"
if "%_PH%"=="1" (
  echo [BAT] ERROR: INVENTORY_SERVER missing or placeholder. Use panel ZIP, not git.
  set "ERR=2"
  goto :done
)
call :is_placeholder "%AGENT_TOKEN%"
if "%_PH%"=="1" (
  echo [BAT] ERROR: AGENT_TOKEN missing or placeholder.
  set "ERR=2"
  goto :done
)

REM PS 3+ (Win8/10/11, or Win7+WMF) has this key. Avoid spawning powershell.exe.
set "CORAX_FLAVOR=win7"
reg query "HKLM\SOFTWARE\Microsoft\PowerShell\3" >NUL 2>&1
if not errorlevel 1 set "CORAX_FLAVOR=win10"
reg query "HKLM\SOFTWARE\Wow6432Node\Microsoft\PowerShell\3" >NUL 2>&1
if not errorlevel 1 set "CORAX_FLAVOR=win10"

if not defined CORAX_HIDDEN (
  echo   OS       Windows  -^> %CORAX_FLAVOR%
  echo   TARGET   %INVENTORY_SERVER%
  echo   START    %DATE% %TIME%
  echo   folder   %CD%
  echo.
)

set "CORAX_INNER=1"
if "%CORAX_FLAVOR%"=="win10" (
  if not exist "%~dp0win10\corax_send.bat" (
    echo [FAIL] win10\corax_send.bat not found
    set "ERR=1"
    goto :done
  )
  call "%~dp0win10\corax_send.bat" %*
  set "ERR=!ERRORLEVEL!"
) else (
  if not exist "%~dp0win7\inventory_send_win7.bat" (
    echo [FAIL] win7\inventory_send_win7.bat not found
    set "ERR=1"
    goto :done
  )
  call "%~dp0win7\inventory_send_win7.bat" %*
  set "ERR=!ERRORLEVEL!"
)
goto :done

:refuse_tree
echo [BAT] ERROR: running inside CORAX server tree. Unpack ZIP to a separate folder
echo        e.g. %%ProgramData%%\CORAX\agent or \\fileserver\corax\agent
echo        not next to docker-compose.yml / backend\.env
set "ERR=2"
goto :done

:is_placeholder
set "_PH=0"
if "%~1"=="" set "_PH=1"
if "%~1"=="__INVENTORY_SERVER__" set "_PH=1"
if "%~1"=="__AGENT_TOKEN__" set "_PH=1"
if "%~1"=="xxxx.yyyy" set "_PH=1"
echo %~1 | findstr /C:"__" >NUL
if not errorlevel 1 set "_PH=1"
goto :eof

:done
if defined INV_MAP_DRIVE (
  net use %INV_MAP_DRIVE% /delete /y >NUL 2>&1
)
if not defined INV_NOPAUSE pause
endlocal & exit /b %ERR%
