#!/usr/bin/env python3
"""Send Wake-on-LAN from the Docker host, not from the container.

A magic packet emitted inside the compose bridge never reaches the office LAN.
This process watches data/wol-queue (bind-mounted into the app container) and
sends the packet from the physical NIC — the same path as a working local script.

Started by `npm run docker:up`. A second copy exits immediately.
"""

from __future__ import annotations

import json
import socket
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
QUEUE = ROOT / "data" / "wol-queue"
ENV_PATH = BACKEND / ".env"
LOCK_PORT = 39217

sys.path.insert(0, str(BACKEND))


def _env_value(key: str) -> str:
    if not ENV_PATH.is_file():
        return ""
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        k, _, v = raw.partition("=")
        if k.strip() == key:
            return v.strip().strip('"').strip("'")
    return ""


def _token_ok(got: str, expected: str) -> bool:
    import hmac

    if not expected or not got or len(got) != len(expected):
        return False
    return hmac.compare_digest(got.encode("utf-8"), expected.encode("utf-8"))


def _result_name(req: Path) -> Path:
    uid = req.name[len("req-") : -len(".json")]
    return req.with_name(f"res-{uid}.json")


def _write_result(req: Path, payload: dict) -> None:
    dest = _result_name(req)
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(dest)
    req.unlink(missing_ok=True)


def handle(req: Path, token: str) -> None:
    from app.wol import normalize_mac, send_wake_local

    try:
        data = json.loads(req.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        req.unlink(missing_ok=True)
        return
    if not isinstance(data, dict) or not _token_ok(str(data.get("token") or ""), token):
        _write_result(req, {"sent": 0, "errors": 1, "detail": "bad_token"})
        return
    try:
        mac = normalize_mac(str(data.get("mac") or ""))
    except ValueError:
        _write_result(req, {"sent": 0, "errors": 1, "detail": "bad_mac"})
        return
    try:
        result = send_wake_local(mac, target_ip=str(data.get("ip") or "") or None)
    except OSError:
        result = {"sent": 0, "errors": 1, "detail": ""}
    _write_result(
        req,
        {
            "sent": int(result.get("sent") or 0),
            "errors": int(result.get("errors") or 0),
            "detail": str(result.get("detail") or ""),
        },
    )


def _lock() -> socket.socket | None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", LOCK_PORT))
    except OSError:
        sock.close()
        return None
    sock.listen(1)
    return sock


def main() -> int:
    lock = _lock()
    if lock is None:
        return 0
    token = _env_value("CORAX_WOL_RELAY_TOKEN")
    QUEUE.mkdir(parents=True, exist_ok=True)
    try:
        QUEUE.chmod(0o777)
    except OSError:
        pass
    while True:
        now = time.time()
        for stale in list(QUEUE.glob("res-*.json")) + list(QUEUE.glob("req-*.json")):
            try:
                if now - stale.stat().st_mtime > 30 and stale.name.startswith("res-"):
                    stale.unlink(missing_ok=True)
            except OSError:
                continue
        for req in list(QUEUE.glob("req-*.json")):
            try:
                if now - req.stat().st_mtime > 30:
                    req.unlink(missing_ok=True)
                    continue
                handle(req, token)
            except OSError:
                continue
        time.sleep(0.05)


if __name__ == "__main__":
    raise SystemExit(main())
