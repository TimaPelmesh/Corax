@echo off
REM Разработка: API :3000 + Vite :5173 (одна команда, как npm start).
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm not found. Install Node.js.
  pause
  exit /b 1
)
where python >nul 2>&1
if errorlevel 1 (
  echo ERROR: python not found.
  pause
  exit /b 1
)

echo [deps] pip + npm ...
pip install -r backend\requirements.txt
if errorlevel 1 (
  echo pip FAILED.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 (
  echo npm install FAILED.
  pause
  exit /b 1
)

echo.
echo [run] API + Vite — UI: http://127.0.0.1:5173
echo Остановка: Ctrl+C
echo.

call npm start

echo.
echo Stopped.
pause
