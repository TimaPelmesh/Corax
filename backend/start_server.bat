@echo off
REM Run from repo: starts API on ALL interfaces so LAN agents can connect.
REM Full stack (build UI + this server): use start_all.bat in the parent folder.
cd /d "%~dp0"

echo Starting uvicorn on 0.0.0.0:3001 (all network interfaces)
echo If agents still fail: run open_firewall_port.bat as Administrator on THIS machine.
echo.
python -m uvicorn app.main:app --host 0.0.0.0 --port 3001 --reload
pause
