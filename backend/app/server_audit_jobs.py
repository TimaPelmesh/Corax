"""Allowlisted Linux admin jobs. The agent polls these; the panel never opens SSH.

A job is a name plus one argument. Paths stay inside a fixed set of config
directories. Unit names cannot carry a shell. sudoers, keys, and cron are refused.
"""

from __future__ import annotations

import posixpath
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ServerAuditHost, ServerAuditJob, User
from app.server_audit_store import find_audit_host

ACTIONS = frozenset({"status", "test", "read", "restart", "write"})
TESTS = frozenset({"nginx", "sshd"})
RESTART_UNITS = frozenset(
    {
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
)
READ_FILES = (
    "/etc/hostname",
    "/etc/hosts",
    "/etc/os-release",
    "/etc/fstab",
    "/etc/resolv.conf",
    "/etc/nginx/nginx.conf",
    "/etc/ssh/sshd_config",
)
READ_PREFIXES = (
    "/etc/nginx/",
    "/etc/apache2/",
    "/etc/httpd/",
    "/etc/ssh/sshd_config.d/",
    "/etc/corax/",
)
WRITE_PREFIXES = (
    "/etc/nginx/conf.d/",
    "/etc/nginx/sites-available/",
    "/etc/apache2/sites-available/",
    "/etc/httpd/conf.d/",
    "/etc/corax/",
)
_UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._@-]{0,80}$")
_DENY_NAMES = frozenset({"shadow", "gshadow", "sudoers", "passwd", "group", "crontab", "authorized_keys"})
_DENY_BITS = ("sudoers", "cron.d", "crontab", "pam.d", "/systemd/", "id_rsa", ".pem", ".key")
_BODY_MAX = 32_768
_OUTPUT_MAX = 65_536
_QUEUE_MAX = 5
_LEASE = timedelta(minutes=5)


def action_catalog() -> dict[str, list[str]]:
    return {
        "tests": sorted(TESTS),
        "restart": sorted(RESTART_UNITS),
        "read": list(READ_FILES),
        "write_prefixes": list(WRITE_PREFIXES),
    }


def _unit(raw: str) -> str | None:
    name = (raw or "").strip()
    if not _UNIT.fullmatch(name):
        return None
    return name


def _unit_base(name: str) -> str:
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
    if path in READ_FILES:
        return True
    return any(path.startswith(prefix) for prefix in READ_PREFIXES)


def _writable(path: str) -> bool:
    if path.endswith("/"):
        return False
    if posixpath.basename(path) in {"", ".", ".."}:
        return False
    return any(path.startswith(prefix) for prefix in WRITE_PREFIXES)


def explain_job(action: str, target: str, body: str | None) -> str | None:
    """None when the job may run. Otherwise a reason safe to show in the panel."""
    kind = (action or "").strip().lower()
    if kind not in ACTIONS:
        return "Неизвестное действие"
    if kind in {"status", "restart", "test"}:
        unit = _unit(target)
        if unit is None:
            return "Имя службы содержит недопустимые символы"
        if kind == "test" and _unit_base(unit) not in TESTS:
            return "Проверять можно только nginx и sshd"
        if kind == "restart" and _unit_base(unit) not in RESTART_UNITS:
            return "Эту службу нельзя перезапускать из панели"
        return None
    path = _path(target)
    if path is None:
        return "Такой путь читать и записывать нельзя"
    if kind == "read":
        if not _readable(path):
            return "Файл вне списка разрешённых"
        return None
    if body is None:
        return "Нет содержимого файла"
    if "\x00" in body or len(body) > _BODY_MAX:
        return "Содержимое файла слишком большое"
    if not _writable(path):
        return "Записывать можно только в каталог конфигов nginx, apache или /etc/corax"
    return None


async def list_jobs(db: AsyncSession, host_id: int, limit: int = 20) -> list[dict]:
    rows = (
        await db.execute(
            select(ServerAuditJob, User.username)
            .outerjoin(User, User.id == ServerAuditJob.requested_by_id)
            .where(ServerAuditJob.host_id == host_id)
            .order_by(ServerAuditJob.id.desc())
            .limit(limit)
        )
    ).all()
    out: list[dict] = []
    for job, username in rows:
        out.append(
            {
                "id": job.id,
                "action": job.action,
                "target": job.target,
                "status": job.status,
                "exit_code": job.exit_code,
                "output": job.output,
                "requested_by": username,
                "created_at": job.created_at,
                "finished_at": job.finished_at,
            }
        )
    return out


async def enqueue_job(
    db: AsyncSession,
    host: ServerAuditHost,
    *,
    user_id: int | None,
    action: str,
    target: str,
    body: str | None,
) -> ServerAuditJob:
    reason = explain_job(action, target, body)
    if reason:
        raise ValueError(reason)
    waiting = int(
        await db.scalar(
            select(func.count())
            .select_from(ServerAuditJob)
            .where(
                ServerAuditJob.host_id == host.id,
                ServerAuditJob.status.in_(("pending", "leased")),
            )
        )
        or 0
    )
    if waiting >= _QUEUE_MAX:
        raise ValueError("На этом хосте уже пять заданий ждут агента")
    kind = action.strip().lower()
    stored_target = target.strip()
    if kind in {"read", "write"}:
        stored_target = _path(target) or stored_target
    elif kind in {"status", "restart", "test"}:
        stored_target = _unit(target) or stored_target
    job = ServerAuditJob(
        host_id=host.id,
        requested_by_id=user_id,
        action=kind,
        target=stored_target,
        body=body if kind == "write" else None,
        status="pending",
    )
    db.add(job)
    await db.flush()
    return job


async def lease_next_job(db: AsyncSession, hostname: str) -> tuple[list[dict], bool]:
    """Hand the oldest pending job to this host. Expired leases are closed."""
    host = await find_audit_host(db, hostname)
    if host is None or not host.enabled:
        return [], False
    now = datetime.now(timezone.utc)
    changed = False
    expired = await db.execute(
        update(ServerAuditJob)
        .where(
            ServerAuditJob.host_id == host.id,
            ServerAuditJob.status == "leased",
            ServerAuditJob.leased_at.is_not(None),
            ServerAuditJob.leased_at < now - _LEASE,
        )
        .values(status="expired", finished_at=now)
    )
    if int(getattr(expired, "rowcount", 0) or 0) > 0:
        changed = True
    job = (
        await db.execute(
            select(ServerAuditJob)
            .where(ServerAuditJob.host_id == host.id, ServerAuditJob.status == "pending")
            .order_by(ServerAuditJob.id.asc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if job is None:
        return [], changed
    job.status = "leased"
    job.leased_at = now
    await db.flush()
    item = {"id": job.id, "action": job.action, "target": job.target}
    if job.action == "write":
        item["body"] = job.body or ""
    return [item], True


async def finish_job(
    db: AsyncSession,
    hostname: str,
    job_id: int,
    exit_code: int,
    output: str,
) -> dict:
    host = await find_audit_host(db, hostname)
    if host is None:
        return {"ok": True, "stored": False, "reason": "unknown_host"}
    job = await db.get(ServerAuditJob, job_id)
    if job is None or job.host_id != host.id:
        return {"ok": True, "stored": False, "reason": "unknown_job"}
    if job.status not in {"leased", "pending"}:
        return {"ok": True, "stored": False, "reason": "closed"}
    code = int(exit_code)
    if code < 0:
        code = 1
    if code > 255:
        code = 255
    job.exit_code = code
    job.output = (output or "")[:_OUTPUT_MAX]
    job.finished_at = datetime.now(timezone.utc)
    job.status = "done" if job.action == "status" or code == 0 else "failed"
    await db.flush()
    return {"ok": True, "stored": True, "reason": "stored", "id": job.id}
