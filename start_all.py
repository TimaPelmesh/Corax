#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WEB_PORT = 3000
API_PORT = 3001


ENV_CONTENT = """ENVIRONMENT=development
SECRET_KEY=dev-secret-key-change-me
AGENT_TOKEN=dev-agent-token-change-in-production
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=admin123
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173
DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
DIAGRAMS_DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
WAREHOUSE_DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
# BITRIX24_WEBHOOK_URL=https://your.bitrix24.ru/rest/1/xxxxxxxxxxxx
"""


def npm_bin() -> str:
    name = "npm.cmd" if os.name == "nt" else "npm"
    found = shutil.which(name)
    if not found:
        raise RuntimeError("npm not found. Install Node.js.")
    return found


def run_checked(cmd: list[str], env: dict[str, str]) -> None:
    print("[run]", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=ROOT, env=env, check=True)


def create_env_file() -> None:
    env_path = ROOT / "backend" / ".env"
    if env_path.exists():
        return
    print("[env] backend/.env not found - creating default dev values", flush=True)
    env_path.write_text(ENV_CONTENT, encoding="utf-8")


def port_is_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def run_quiet(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def free_port_windows(port: int) -> None:
    ps = (
        f"$port={port}; "
        "$pids=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue "
        "| Select-Object -ExpandProperty OwningProcess -Unique); "
        "if(-not $pids){ Write-Host ('[ports] ' + $port + ' is already free'); exit 0 }; "
        "foreach($procId in $pids){ "
        "try { Stop-Process -Id $procId -Force -ErrorAction Stop; "
        "Write-Host ('[ports] killed PID ' + $procId + ' on port ' + $port) } "
        "catch { Write-Host ('[ports] failed to kill PID ' + $procId + ' on port ' + $port) } }"
    )
    subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        cwd=ROOT,
        check=False,
    )


def free_port_unix(port: int) -> None:
    if not port_is_open(port):
        print(f"[ports] {port} is already free", flush=True)
        return

    fuser = shutil.which("fuser")
    if fuser:
        result = run_quiet([fuser, "-k", f"{port}/tcp"])
        if result.returncode == 0 or not port_is_open(port):
            print(f"[ports] killed process on port {port}", flush=True)
            return

    lsof = shutil.which("lsof")
    if lsof:
        result = run_quiet([lsof, "-ti", f"tcp:{port}"])
        pids = [pid.strip() for pid in result.stdout.splitlines() if pid.strip()]
        for pid in pids:
            try:
                os.kill(int(pid), signal.SIGTERM)
                print(f"[ports] killed PID {pid} on port {port}", flush=True)
            except OSError as exc:
                print(f"[ports] failed to kill PID {pid} on port {port}: {exc}", flush=True)
        time.sleep(0.5)
        if not port_is_open(port):
            return

    print(
        f"[ports] port {port} is busy, but no supported killer was available. "
        "Install fuser/lsof or stop the process manually.",
        flush=True,
    )


def free_port(port: int) -> None:
    if os.name == "nt":
        free_port_windows(port)
    else:
        free_port_unix(port)


def terminate_process(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            proc.terminate()
        else:
            os.killpg(proc.pid, signal.SIGTERM)
    except OSError:
        pass


def start_process(cmd: list[str], env: dict[str, str]) -> subprocess.Popen[bytes]:
    kwargs: dict[str, object] = {"cwd": ROOT, "env": env}
    if os.name != "nt":
        kwargs["start_new_session"] = True
    print("[run]", " ".join(cmd), flush=True)
    return subprocess.Popen(cmd, **kwargs)


def main() -> int:
    parser = argparse.ArgumentParser(description="Start CORAX API and web UI.")
    parser.add_argument("--skip-install", action="store_true", help="Skip pip/npm install.")
    parser.add_argument("--browser", action="store_true", help="Open the web UI in a browser after startup.")
    parser.add_argument("--no-kill-ports", action="store_true", help="Do not free ports before startup.")
    args = parser.parse_args()

    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["WEB_PORT"] = str(WEB_PORT)
    env["API_PORT"] = str(API_PORT)
    env["PORT"] = str(API_PORT)
    env["HOST"] = "0.0.0.0"

    try:
        npm = npm_bin()
        if not args.skip_install:
            run_checked([sys.executable, "-m", "pip", "install", "-r", str(ROOT / "backend" / "requirements.txt")], env)
            run_checked([npm, "install"], env)

        create_env_file()

        scripts_dir = str(ROOT / "scripts")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        from ensure_postgres import ensure_postgres

        print("[db] PostgreSQL (локальная служба)...", flush=True)
        ensure_postgres()

        if not args.no_kill_ports:
            print(f"[ports] freeing {WEB_PORT} and {API_PORT} if occupied", flush=True)
            free_port(WEB_PORT)
            free_port(API_PORT)

        web_url = f"http://127.0.0.1:{WEB_PORT}/"
        api_url = f"http://127.0.0.1:{API_PORT}/"
        host_name = platform.node() or "localhost"
        print("", flush=True)
        print(f"[run] web (local): {web_url}", flush=True)
        print(f"[run] web (LAN):   смотрите Network в логе Vite, например http://192.168.x.x:{WEB_PORT}/", flush=True)
        print(f"[run] api: {api_url}", flush=True)
        print(f"[run] agent server URL: http://{host_name}:{API_PORT}/", flush=True)
        print("[run] stop with Ctrl+C", flush=True)
        print("", flush=True)

        if args.browser:
            webbrowser.open(web_url)

        api_proc = start_process([sys.executable, str(ROOT / "run.py")], env)
        print("[run] waiting for API on 127.0.0.1:3001 …", flush=True)
        deadline = time.time() + 120
        while time.time() < deadline:
            if port_is_open(API_PORT):
                break
            if api_proc.poll() is not None:
                return int(api_proc.returncode or 1)
            time.sleep(0.25)
        else:
            print("ERROR: API did not open port 3001 in time", flush=True)
            terminate_process(api_proc)
            return 1

        web_proc = start_process([npm, "run", "dev", "--prefix", "frontend"], env)

        while True:
            api_code = api_proc.poll()
            web_code = web_proc.poll()
            if api_code is not None:
                terminate_process(web_proc)
                return int(api_code)
            if web_code is not None:
                terminate_process(api_proc)
                return int(web_code)
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[stop] stopping services", flush=True)
        return 130
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: command failed with exit code {exc.returncode}", flush=True)
        return int(exc.returncode)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", flush=True)
        return 1
    finally:
        for proc_name in ("api_proc", "web_proc"):
            proc = locals().get(proc_name)
            if proc is not None:
                terminate_process(proc)


if __name__ == "__main__":
    raise SystemExit(main())
