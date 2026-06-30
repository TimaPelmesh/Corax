@echo off
setlocal
rem One-click start: PostgreSQL, deps, API on 3001 and web on 3000.
cd /d "%~dp0"

set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "WEB_PORT=3000"
set "API_PORT=3001"
set "PORT=%API_PORT%"
set "HOST=0.0.0.0"

where npm.cmd >nul 2>nul
if errorlevel 1 goto :npm_missing

where python >nul 2>nul
if errorlevel 1 goto :python_missing

echo [deps] pip install -r backend\requirements.txt
python -m pip install -r backend\requirements.txt
if errorlevel 1 goto :pip_failed

echo [deps] npm install
call npm.cmd install
if errorlevel 1 goto :npm_failed

if not exist "backend\.env" call :write_env

echo.
echo [db] PostgreSQL (локальная служба)...
call :ensure_pg_service
python scripts\ensure_postgres.py
if errorlevel 1 goto :db_failed

echo.
echo [ports] freeing %WEB_PORT% and %API_PORT% if occupied
call :free_port "%WEB_PORT%"
call :free_port "%API_PORT%"

echo.
echo [run] web local: http://127.0.0.1:%WEB_PORT%/
echo [run] web LAN:   смотрите Network в логе Vite, например http://192.168.x.x:%WEB_PORT%/
echo [run] api: http://127.0.0.1:%API_PORT%/ (прокси с фронта на %API_PORT%)
echo [run] agent server URL: http://%COMPUTERNAME%:%API_PORT%/
echo [run] stop with Ctrl+C
echo.

call npm.cmd run start

echo.
echo Server stopped.
pause
exit /b 0

:write_env
echo [env] backend\.env not found - creating default dev values
(
  echo ENVIRONMENT=development
  echo SECRET_KEY=dev-secret-key-change-me
  echo AGENT_TOKEN=dev-agent-token-change-in-production
  echo BOOTSTRAP_ADMIN_USERNAME=admin
  echo BOOTSTRAP_ADMIN_PASSWORD=admin123
  echo CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173
  echo DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
  echo DIAGRAMS_DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
  echo WAREHOUSE_DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
  echo # BITRIX24_WEBHOOK_URL=https://your.bitrix24.ru/rest/1/xxxxxxxxxxxx
) > "backend\.env"
exit /b 0

:free_port
set "TARGET_PORT=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port=%TARGET_PORT%; $pids=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if(-not $pids){ Write-Host ('[ports] ' + $port + ' is already free'); exit 0 }; foreach($procId in $pids){ try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Host ('[ports] killed PID ' + $procId + ' on port ' + $port) } catch { Write-Host ('[ports] failed to kill PID ' + $procId + ' on port ' + $port) } }"
exit /b 0

:ensure_pg_service
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$svc = Get-Service -Name 'postgresql-x64-16' -ErrorAction SilentlyContinue; " ^
  "if (-not $svc) { $svc = Get-Service -Name '*postgres*' -ErrorAction SilentlyContinue | Select-Object -First 1 }; " ^
  "if (-not $svc) { exit 0 }; " ^
  "if ($svc.Status -eq 'Running') { Write-Host '[db] PostgreSQL уже запущен'; exit 0 }; " ^
  "Write-Host '[db] Запуск службы' $svc.Name '...'; " ^
  "try { Start-Service -Name $svc.Name -ErrorAction Stop; exit 0 } catch { }; " ^
  "Write-Host '[db] Нужны права администратора — подтвердите UAC'; " ^
  "Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile','-Command',\"Start-Service -Name '$($svc.Name)'\")"
exit /b 0

:npm_missing
echo ERROR: npm not found. Install Node.js.
pause
exit /b 1

:python_missing
echo ERROR: python not found.
pause
exit /b 1

:pip_failed
echo ERROR: pip install failed.
pause
exit /b 1

:npm_failed
echo ERROR: npm install failed.
pause
exit /b 1

:db_failed
echo.
echo ERROR: PostgreSQL не поднялся. См. сообщения [db] выше.
pause
exit /b 1
