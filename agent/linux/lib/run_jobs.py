#!/usr/bin/env python3
"""Run one allowlisted CORAX job from the audit directive and post the result.

The panel chooses the action. This process refuses anything that is not a
known action, a safe unit name, or a path inside the config directories.
It never calls a shell.
"""
from __future__ import annotations

import json
import os
import posixpath
import re
import sys
import urllib.error
import urllib.request

_UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._@-]{0,80}$")
_TESTS = {"nginx": ["nginx", "-t"], "sshd": ["sshd", "-t"]}
_RESTART = {
    "nginx",
    "apache2",
    "httpd",
    "ssh",
    "sshd",
    "cron",
    "crond",
    "docker",
    "containerd",
    "postgresql",
    "mariadb",
    "mysql",
    "redis",
    "redis-server",
    "named",
    "bind9",
    "corax-audit",
}
_READ_FILES = {
    "/etc/hostname",
    "/etc/hosts",
    "/etc/os-release",
    "/etc/fstab",
    "/etc/resolv.conf",
    "/etc/nginx/nginx.conf",
    "/etc/ssh/sshd_config",
}
_READ_PREFIXES = (
    "/etc/nginx/",
    "/etc/apache2/",
    "/etc/httpd/",
    "/etc/ssh/sshd_config.d/",
    "/etc/corax/",
)
_WRITE_PREFIXES = (
    "/etc/nginx/conf.d/",
    "/etc/nginx/sites-available/",
    "/etc/apache2/sites-available/",
    "/etc/httpd/conf.d/",
    "/etc/corax/",
)
_DENY_NAMES = {"shadow", "gshadow", "sudoers", "passwd", "group", "crontab", "authorized_keys"}
_DENY_BITS = ("sudoers", "cron.d", "crontab", "pam.d", "/systemd/", "id_rsa", ".pem", ".key")
_BODY_MAX = 32_768
_OUT_MAX = 65_536


def _unit(raw: str) -> str | None:
    name = (raw or "").strip()
    if not _UNIT.fullmatch(name):
        return None
    return name


def _base(name: str) -> str:
    return name[:-8] if name.endswith(".service") else name


def _path(raw: str) -> str | None:
    text = (raw or "").strip()
    if not text.startswith("/") or "\x00" in text or "\\" in text:
        return None
    if any(part == ".." for part in text.split("/")):
        return None
    normal = posixpath.normpath(text)
    if normal != text.rstrip("/") or not normal.startswith("/"):
        return None
    lowered = normal.lower()
    parts = [part.lower() for part in normal.split("/") if part]
    if any(part in _DENY_NAMES for part in parts):
        return None
    if any(bit in lowered for bit in _DENY_BITS):
        return None
    return normal


def _readable(path: str) -> bool:
    return path in _READ_FILES or any(path.startswith(prefix) for prefix in _READ_PREFIXES)


def _writable(path: str) -> bool:
    if path.endswith("/"):
        return False
    return any(path.startswith(prefix) for prefix in _WRITE_PREFIXES)


def _run(argv: list[str], timeout: float = 25) -> tuple[int, str]:
    import subprocess

    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "LC_ALL": "C"},
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)[:_OUT_MAX]
    text = ((proc.stdout or "") + (proc.stderr or ""))[:_OUT_MAX]
    return int(proc.returncode or 0), text


def _read(path: str) -> tuple[int, str]:
    if os.path.islink(path) or not os.path.isfile(path):
        return 1, "Файл не найден или это ссылка"
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return 0, fh.read(_OUT_MAX)
    except OSError as exc:
        return 1, str(exc)[:_OUT_MAX]


def _write(path: str, body: str) -> tuple[int, str]:
    if os.path.islink(path):
        return 1, "Путь — ссылка, запись отменена"
    parent = os.path.dirname(path)
    if os.path.islink(parent):
        return 1, "Каталог — ссылка, запись отменена"
    try:
        os.makedirs(parent, mode=0o755, exist_ok=True)
        tmp = path + ".corax.tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except OSError as exc:
        return 1, str(exc)[:_OUT_MAX]
    return 0, "Файл записан"


def execute(job: dict) -> tuple[int, str]:
    action = str(job.get("action") or "").strip().lower()
    target = str(job.get("target") or "")
    if action == "status":
        unit = _unit(target)
        if unit is None:
            return 1, "Имя службы отклонено"
        return _run(["systemctl", "status", unit, "--no-pager", "-n", "40"])
    if action == "test":
        unit = _unit(target)
        if unit is None or _base(unit) not in _TESTS:
            return 1, "Проверка отклонена"
        return _run(_TESTS[_base(unit)])
    if action == "restart":
        unit = _unit(target)
        if unit is None or _base(unit) not in _RESTART:
            return 1, "Перезапуск отклонён"
        return _run(["systemctl", "restart", unit], timeout=40)
    if action == "read":
        path = _path(target)
        if path is None or not _readable(path):
            return 1, "Чтение отклонено"
        return _read(path)
    if action == "write":
        path = _path(target)
        body = job.get("body")
        if path is None or not _writable(path) or not isinstance(body, str) or len(body) > _BODY_MAX or "\x00" in body:
            return 1, "Запись отклонена"
        return _write(path, body)
    return 1, "Неизвестное действие"


def _post(origin: str, token: str, job_id: int, hostname: str, code: int, output: str) -> None:
    url = origin.rstrip("/") + "/api/v1/agent/audit-job"
    payload = json.dumps(
        {"id": job_id, "hostname": hostname, "exit_code": code, "output": output[:_OUT_MAX]},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read(1024)
    except urllib.error.URLError:
        return


def main() -> int:
    if len(sys.argv) < 2:
        return 0
    try:
        data = json.loads(open(sys.argv[1], encoding="utf-8").read())
    except (OSError, json.JSONDecodeError):
        return 0
    if not isinstance(data, dict):
        return 0
    jobs = data.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        return 0
    job = jobs[0]
    if not isinstance(job, dict) or not isinstance(job.get("id"), int):
        return 0
    token = (os.environ.get("AGENT_TOKEN") or "").strip()
    base = (os.environ.get("INVENTORY_SERVER") or "").strip().rstrip("/")
    hostname = str(data.get("hostname") or "").strip()
    if not token or not base or not hostname:
        return 0
    code, output = execute(job)
    _post(base, token, int(job["id"]), hostname, code, output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
