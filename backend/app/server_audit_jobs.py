"""Allowlisted Linux admin jobs. The agent polls these; the panel never opens SSH.

A job is a name plus one argument. Paths stay inside a fixed set of config
directories. Unit names cannot carry a shell. sudoers, keys, and cron are refused.
"""

from __future__ import annotations

import json
import posixpath
import re
import shlex
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.llm_metrics import MODEL_ROOTS, explain_llm_job, llm_unit_base
from app.models import LlmClusterNode, LlmControlAudit, ServerAuditHost, ServerAuditJob, User
from app.server_audit_store import find_audit_host

_LLM_ACTIONS = frozenset({"start", "stop", "journal", "llama-apply", "models", "rpc-probe"})
ACTIONS = frozenset({"status", "test", "read", "restart", "write", "units", "show", "list", "docker", "playbook"}) | _LLM_ACTIONS
_HOLD_UNITS = frozenset({"systemd", "init", "dbus", "dbus-broker", "polkit", "polkitd"})
_SHELL_NAMES = frozenset({"bash", "sh", "dash", "zsh", "python", "python3", "perl"})
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
_SCRIPT_PREFIXES = (
    "/opt/corax/scripts/",
    "/var/lib/corax/scripts/",
)
_COMPOSE_PREFIXES = (
    "/etc/corax/compose/",
    "/opt/corax/compose/",
)
READ_PREFIXES = (
    "/etc/nginx/",
    "/etc/apache2/",
    "/etc/httpd/",
    "/etc/ssh/sshd_config.d/",
    "/etc/corax/",
    *_SCRIPT_PREFIXES,
    *_COMPOSE_PREFIXES,
)
WRITE_PREFIXES = (
    "/etc/nginx/conf.d/",
    "/etc/nginx/sites-available/",
    "/etc/apache2/sites-available/",
    "/etc/httpd/conf.d/",
    "/etc/corax/",
    *_SCRIPT_PREFIXES,
    *_COMPOSE_PREFIXES,
)
_DOCKER_VERBS = frozenset({"ps", "start", "stop", "restart", "compose-up", "compose-down"})
_CONTAINER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_PLAYBOOK_MAX = 8
_UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._@-]{0,80}$")
_DENY_NAMES = frozenset({"shadow", "gshadow", "sudoers", "passwd", "group", "crontab", "authorized_keys"})
_DENY_BITS = ("sudoers", "cron.d", "crontab", "pam.d", "/systemd/", "id_rsa", ".pem", ".key")
_BODY_MAX = 32_768
_OUTPUT_MAX = 65_536
_QUEUE_MAX = 5
_LEASE = timedelta(minutes=5)


def _controllable(name: str) -> bool:
    base = _unit_base(name)
    return base not in _HOLD_UNITS and base not in _SHELL_NAMES


def ssh_units() -> frozenset[str]:
    names = set(RESTART_UNITS)
    names.update(
        {
            "llama-server",
            "rpc-server",
            *(f"rpc-server-gpu{index}" for index in range(8)),
        }
    )
    return frozenset(names)


def ssh_admin_command(action: str, target: str, lines: int) -> tuple[str, int]:
    """One remote command. No shell from the browser: the unit comes from the allowlist."""
    kind = (action or "").strip().lower()
    if kind == "gpu":
        return "nvidia-smi", 25
    if kind not in {"logs", "status", "start", "stop", "restart"}:
        raise ValueError("Такой SSH-команды нет")
    unit = _unit(target)
    if unit is None or not _controllable(unit):
        raise ValueError("Эту службу по SSH запускать и читать нельзя")
    quoted = shlex.quote(unit)
    if kind == "logs":
        count = 120 if not isinstance(lines, int) else max(20, min(400, lines))
        return f"journalctl -u {quoted} -n {count} --no-pager -o short-iso", 30
    if kind == "status":
        return f"systemctl status {quoted} --no-pager -l", 20
    return f"systemctl {kind} {quoted}", 40


def action_catalog() -> dict[str, list[str]]:
    return {
        "tests": sorted(TESTS),
        "restart": sorted(RESTART_UNITS),
        "read": list(READ_FILES),
        "write_prefixes": list(WRITE_PREFIXES),
        "llm_units": [
            "llama-server",
            "rpc-server",
            "rpc-server-gpu0",
            "rpc-server-gpu1",
            "rpc-server-gpu2",
            "rpc-server-gpu3",
            "rpc-server-gpu4",
            "rpc-server-gpu5",
            "rpc-server-gpu6",
            "rpc-server-gpu7",
        ],
        "model_roots": list(MODEL_ROOTS),
        "list_prefixes": [_prefix_root(prefix) for prefix in _list_prefixes()],
        "compose_prefixes": [_prefix_root(prefix) for prefix in _COMPOSE_PREFIXES],
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


def _prefix_root(prefix: str) -> str:
    return prefix.rstrip("/")


def _under(path: str, prefixes: tuple[str, ...]) -> bool:
    for prefix in prefixes:
        root = _prefix_root(prefix)
        if path == root or path.startswith(root + "/"):
            return True
    return False


def _list_prefixes() -> tuple[str, ...]:
    roots = tuple(root if root.endswith("/") else root + "/" for root in MODEL_ROOTS)
    return READ_PREFIXES + roots


def _listable(path: str) -> bool:
    return _under(path, _list_prefixes())


def _container_name(raw: str | None) -> str | None:
    name = (raw or "").strip()
    if not _CONTAINER.fullmatch(name):
        return None
    return name


def _compose_dir(raw: str | None) -> str | None:
    path = _path(raw or "")
    if path is None or not _under(path, _COMPOSE_PREFIXES):
        return None
    return path


def _hidden_file(path: str) -> bool:
    name = posixpath.basename(path).lower()
    return name == ".env" or name.endswith(".env")


def _readable(path: str) -> bool:
    if _hidden_file(path):
        return False
    if path in READ_FILES:
        return True
    return any(path.startswith(prefix) for prefix in READ_PREFIXES)


def _writable(path: str) -> bool:
    if path.endswith("/") or _hidden_file(path):
        return False
    if posixpath.basename(path) in {"", ".", ".."}:
        return False
    return any(path.startswith(prefix) for prefix in WRITE_PREFIXES)


def explain_job(action: str, target: str, body: str | None) -> str | None:
    """None when the job may run. Otherwise a reason safe to show in the panel."""
    kind = (action or "").strip().lower()
    if kind not in ACTIONS:
        return "Неизвестное действие"
    if kind in _LLM_ACTIONS:
        return explain_llm_job(kind, target, body)
    if kind == "units":
        if (target or "").strip() not in {"", "service"} or body not in (None, ""):
            return "Список служб не принимает лишние аргументы"
        return None
    if kind in {"status", "restart", "show", "test"}:
        unit = _unit(target)
        if unit is None:
            return "Имя службы содержит недопустимые символы"
        if kind == "test" and _unit_base(unit) not in TESTS:
            return "Проверять можно только nginx и sshd"
        if kind in {"restart", "show"} and not _controllable(unit):
            return "Эту службу нельзя останавливать из панели: от неё зависит сама машина"
        if kind == "restart" and body not in (None, ""):
            return "Перезапуск не принимает произвольные аргументы"
        return None
    if kind == "list":
        if body not in (None, ""):
            return "Просмотр каталога не принимает содержимое"
        path = _path(target)
        if path is None or not _listable(path):
            return "Этот каталог из панели не показывается"
        return None
    if kind == "docker":
        return _explain_docker(target, body)
    if kind == "playbook":
        return _explain_playbook(body)
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


def _explain_docker(target: str, body: str | None) -> str | None:
    verb = (target or "").strip().lower()
    if verb not in _DOCKER_VERBS:
        return "Такой команды Docker нет"
    if verb == "ps":
        if body not in (None, ""):
            return "Список контейнеров не принимает аргументы"
        return None
    if verb in {"start", "stop", "restart"}:
        if _container_name(body) is None:
            return "Имя контейнера отклонено"
        return None
    if _compose_dir(body) is None:
        return "Compose-проект должен лежать в /etc/corax/compose или /opt/corax/compose"
    return None


def _explain_playbook(body: str | None) -> str | None:
    if not isinstance(body, str) or not body.strip() or len(body) > _BODY_MAX or "\x00" in body:
        return "Плейбук пустой или слишком большой"
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return "Плейбук не разобран"
    if not isinstance(data, dict) or set(data) - {"steps"}:
        return "Плейбук принимает только шаги"
    steps = data.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= _PLAYBOOK_MAX:
        return "В плейбуке от 1 до 8 шагов"
    for step in steps:
        if not isinstance(step, dict) or set(step) - {"action", "target", "body"}:
            return "Шаг плейбука неполный"
        action = str(step.get("action") or "").strip().lower()
        if action == "playbook":
            return "Плейбук нельзя вкладывать"
        step_body = step.get("body")
        if step_body is not None and not isinstance(step_body, str):
            return "Шаг плейбука неполный"
        reason = explain_job(action, str(step.get("target") or ""), step_body)
        if reason:
            return reason
    return None


def _audit_llm(kind: str, target: str) -> bool:
    if kind in _LLM_ACTIONS:
        return True
    return kind == "restart" and llm_unit_base(target) is not None


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
    stored_body = body if kind in {"write", "journal", "llama-apply", "rpc-probe", "docker", "playbook"} else None
    if kind in {"read", "write", "list"}:
        stored_target = _path(target) or stored_target
    elif kind in {"status", "restart", "test", "start", "stop", "journal"}:
        stored_target = _unit(target) or stored_target
    elif kind == "llama-apply":
        stored_target = "llama-server"
    elif kind == "models":
        from app.llm_metrics import model_dir_allowed

        stored_target = model_dir_allowed(target) or stored_target
    elif kind == "rpc-probe":
        stored_target = "rpc"
    elif kind == "docker":
        stored_target = target.strip().lower()
        if stored_target in {"start", "stop", "restart"}:
            stored_body = _container_name(body)
        elif stored_target in {"compose-up", "compose-down"}:
            stored_body = _compose_dir(body)
        else:
            stored_body = None
    elif kind == "playbook":
        stored_target = "run"
    job = ServerAuditJob(
        host_id=host.id,
        requested_by_id=user_id,
        action=kind,
        target=stored_target,
        body=stored_body,
        status="pending",
    )
    db.add(job)
    await db.flush()
    if _audit_llm(kind, stored_target):
        username = ""
        if user_id is not None:
            actor = await db.get(User, user_id)
            username = ((actor.username if actor is not None else "") or "")[:64]
        node_id = await db.scalar(select(LlmClusterNode.id).where(LlmClusterNode.host_id == host.id))
        db.add(
            LlmControlAudit(
                user_id=user_id,
                username=username,
                host_id=host.id,
                node_id=node_id,
                action=kind[:32],
                target=stored_target[:255],
                params_json=(stored_body or None),
                job_id=job.id,
            )
        )
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
    if job.action in {"write", "journal", "llama-apply", "rpc-probe", "docker", "playbook"} and job.body:
        item["body"] = job.body
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
