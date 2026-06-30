"""
Single-entry inventory agent runner intended for packaging into .exe (PyInstaller).

- Token and default server can be embedded directly in this file.
- Environment variables still override defaults:
    INVENTORY_SERVER, AGENT_TOKEN, INVENTORY_QUEUE_DIR

This script reuses the existing collector in agent.py to keep data consistent
between Windows 7 and Windows 10/11 as much as possible.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

from agent import collect_report


# ---- EMBEDDED DEFAULTS (edit these before building .exe) ----
DEFAULT_INVENTORY_SERVER = ""
# Paste your agent token here (or keep empty and set AGENT_TOKEN env var)
EMBEDDED_AGENT_TOKEN = ""
# ------------------------------------------------------------


def _pick_server(cli: str | None) -> str:
    if cli and cli.strip():
        return cli.strip().rstrip("/")
    env = (os.environ.get("INVENTORY_SERVER") or "").strip().rstrip("/")
    if env:
        return env
    return DEFAULT_INVENTORY_SERVER.rstrip("/")


def _pick_token(cli: str | None) -> str:
    if cli and cli.strip():
        return cli.strip()
    env = (os.environ.get("AGENT_TOKEN") or "").strip()
    if env:
        return env
    return (EMBEDDED_AGENT_TOKEN or "").strip()


def _pick_queue_dir() -> Path:
    queue_dir_env = (os.environ.get("INVENTORY_QUEUE_DIR") or "").strip()
    if queue_dir_env:
        return Path(queue_dir_env)
    if sys.platform == "win32":
        root = (os.environ.get("ProgramData") or os.environ.get("TEMP") or "").strip()
        if root:
            return Path(root) / "InventoryAgent"
        return Path.cwd() / "InventoryAgent"
    return Path.home() / ".inventory_agent"


def _try_send(url: str, headers: dict[str, str], body: bytes) -> bool:
    backoff = [2, 5, 15]
    for attempt in range(1, len(backoff) + 2):
        try:
            r = requests.post(url, data=body, headers=headers, timeout=120)
        except requests.RequestException as exc:
            if attempt <= len(backoff):
                time.sleep(backoff[attempt - 1])
                continue
            print("ERROR: network failure:", exc, file=sys.stderr)
            return False
        if r.status_code >= 500:
            if attempt <= len(backoff):
                time.sleep(backoff[attempt - 1])
                continue
            print("ERROR: server error:", r.status_code, r.text, file=sys.stderr)
            return False
        if r.status_code >= 400:
            print("ERROR:", r.status_code, r.text, file=sys.stderr)
            return False
        try:
            print("OK:", r.json())
        except Exception:
            print("OK")
        return True
    return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="inventory-agent", add_help=True)
    ap.add_argument("--server", help="Override INVENTORY_SERVER, e.g. http://192.168.1.10:3001")
    ap.add_argument("--token", help="Override AGENT_TOKEN (NOT recommended; prefer env or embedded)")
    ap.add_argument("--once", action="store_true", help="Send once and exit (default)")
    ns = ap.parse_args(argv)

    server = _pick_server(ns.server)
    token = _pick_token(ns.token)
    if not server:
        print("ERROR: INVENTORY_SERVER is not set. Example: http://192.168.1.10:3001", file=sys.stderr)
        return 2
    if not token:
        print("ERROR: AGENT_TOKEN is not set and EMBEDDED_AGENT_TOKEN is empty.", file=sys.stderr)
        return 2

    report = collect_report()
    url = f"{server}/api/v1/agent/inventory"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload_bytes = json.dumps(report, ensure_ascii=False).encode("utf-8")

    queue_dir = _pick_queue_dir()
    queue_dir.mkdir(parents=True, exist_ok=True)
    queue_file = queue_dir / "pending_report.json"

    # Store-and-forward: send previous unsent report first.
    if queue_file.is_file():
        try:
            prev = queue_file.read_bytes()
        except OSError:
            prev = b""
        if prev:
            print("Found pending report, sending first...")
            if _try_send(url, headers, prev):
                try:
                    queue_file.unlink(missing_ok=True)
                except OSError:
                    pass

    print("Sending to", url)
    print("Host:", report.get("hostname"), "| software:", len(report.get("software", [])), "| pnp:", len(report.get("peripherals", [])))
    if not _try_send(url, headers, payload_bytes):
        try:
            queue_file.write_bytes(payload_bytes)
            print("Saved pending report to", str(queue_file), file=sys.stderr)
        except OSError:
            pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

