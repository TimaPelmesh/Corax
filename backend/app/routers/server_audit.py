"""Panel API for the Linux server-audit tab."""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from app.auth import get_current_editor_or_superuser, get_current_user
from app.database import get_db
from app.linux_install import InstallError, clean_ssh_host, push_script_update, run_remote_command
from app.models import Computer, LlmControlAudit, ServerAuditHost, ServerAuditSample, User
from app.schemas import (
    ServerAuditDetail,
    ServerAuditHostCreate,
    ServerAuditHostOut,
    ServerAuditHostUpdate,
    ServerAuditJobCreate,
    ServerAuditJobOut,
    ServerAuditPoint,
    ServerAuditSshIn,
)
from app.server_audit_jobs import action_catalog, enqueue_job, list_jobs, ssh_admin_command
from app.server_audit_store import (
    ALLOWED_INTERVALS,
    JOURNAL_LINES,
    JOURNAL_MODES,
    RETAIN_DAYS,
    _link_computer,
    apply_journal_now,
    find_audit_host,
    load_chart_samples,
    interval_seconds_of,
    minutes_mirror,
)

router = APIRouter(prefix="/server-audit", tags=["server-audit"])


@router.get("/actions")
async def audit_actions(_: User = Depends(get_current_editor_or_superuser)):
    """Names the agent is willing to run. The panel cannot extend this list."""
    return action_catalog()


@router.get("/hosts/{host_id}/jobs", response_model=list[ServerAuditJobOut])
async def host_jobs(
    host_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    await _host_or_404(db, host_id)
    return await list_jobs(db, host_id)


@router.post("/hosts/{host_id}/jobs", response_model=ServerAuditJobOut)
async def host_job_create(
    host_id: int,
    body: ServerAuditJobCreate,
    user: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    host = await _host_or_404(db, host_id)
    if not host.enabled:
        raise HTTPException(status_code=400, detail="Сбор на этом хосте выключен, агент задания не заберёт")
    try:
        job = await enqueue_job(
            db,
            host,
            user_id=user.id,
            action=body.action,
            target=body.target,
            body=body.body,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    rows = await list_jobs(db, host.id, limit=5)
    found = next((row for row in rows if row["id"] == job.id), None)
    if found is None:
        raise HTTPException(status_code=500, detail="Задание не сохранилось")
    return found


async def _session_user(current: User = Depends(get_current_user)) -> User:
    if current.is_superuser:
        return current
    role = (getattr(current, "role", "") or "").strip().lower()
    if role in {"editor", "llm-operator"}:
        return current
    raise HTTPException(status_code=403, detail="Недостаточно прав для SSH на хост аудита")


@router.post("/hosts/{host_id}/ssh")
async def host_ssh(
    host_id: int,
    body: ServerAuditSshIn,
    user: User = Depends(_session_user),
    db: AsyncSession = Depends(get_db),
):
    """Run one allowlisted command on this host. The password is not stored."""
    host = await _host_or_404(db, host_id)
    ips = await _ips(db, [host])
    raw = (ips.get(host.computer_id or 0) or "").strip() or host.hostname
    try:
        address = clean_ssh_host(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail="У хоста нет IP в парке, а имя не годится для SSH. Привяжите компьютер с адресом.",
        ) from exc
    try:
        if body.action == "update-scripts":
            result = await asyncio.to_thread(
                push_script_update,
                address,
                body.ssh_port,
                body.ssh_user,
                body.ssh_password,
            )
        else:
            command, timeout = ssh_admin_command(body.action, body.target, body.lines)
            result = await asyncio.to_thread(
                run_remote_command,
                address,
                body.ssh_port,
                body.ssh_user,
                body.ssh_password,
                command,
                float(timeout),
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except InstallError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    db.add(
        LlmControlAudit(
            user_id=user.id,
            username=(user.username or "")[:64],
            host_id=host.id,
            action=("ssh-" + body.action)[:32],
            target=(body.target or address)[:255],
            params_json=json.dumps(
                {"via": "ssh", "exit_code": result.get("exit_code")},
                ensure_ascii=False,
            ),
        )
    )
    try:
        await db.commit()
    except Exception:
        await db.rollback()
    result["address"] = address
    return result


_HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$")
_POINT_CAP = 800


def _clean_hostname(value: str) -> str:
    host = (value or "").strip().rstrip(".")
    if not _HOST_RE.match(host):
        raise HTTPException(status_code=400, detail="Имя хоста: буквы, цифры, точка, дефис")
    return host


def _clean_interval_seconds(seconds: int | None, minutes: int | None) -> int:
    if seconds is not None:
        value = int(seconds)
    elif minutes is not None:
        value = int(minutes) * 60
    else:
        value = 900
    if value not in ALLOWED_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail="Интервал: вручную, 15 или 30 секунд, затем 1, 5, 15, 30, 60, 180, 360, 720 или 1440 минут",
        )
    return value


def _clip(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text[:limit] or None


async def _host_or_404(db: AsyncSession, host_id: int) -> ServerAuditHost:
    host = await db.get(ServerAuditHost, host_id)
    if host is None:
        raise HTTPException(status_code=404, detail="Хост аудита не найден")
    return host


async def _ips(db: AsyncSession, hosts: list[ServerAuditHost]) -> dict[int, str | None]:
    ids = [host.computer_id for host in hosts if host.computer_id]
    if not ids:
        return {}
    rows = (await db.execute(select(Computer.id, Computer.ip_address).where(Computer.id.in_(ids)))).all()
    return {row.id: row.ip_address for row in rows}


def _host_out(host: ServerAuditHost, ip: str | None = None, *, with_notes: bool = True) -> ServerAuditHostOut:
    return ServerAuditHostOut(
        id=host.id,
        hostname=host.hostname,
        label=host.label,
        notes=host.notes if with_notes else None,
        enabled=bool(host.enabled),
        interval_minutes=minutes_mirror(interval_seconds_of(host)),
        interval_seconds=interval_seconds_of(host),
        collect_requested=bool(host.collect_requested),
        journal_mode=(host.journal_mode or "errors"),
        journal_lines=int(host.journal_lines or 0),
        retain_days=int(host.retain_days or 14),
        computer_id=host.computer_id,
        ip_address=ip,
        os_summary=host.os_summary,
        latest_cpu_temp_c=host.latest_cpu_temp_c,
        latest_gpu_temp_c=host.latest_gpu_temp_c,
        latest_cpu_percent=host.latest_cpu_percent,
        latest_mem_percent=host.latest_mem_percent,
        latest_disk_percent=host.latest_disk_percent,
        latest_load_1=host.latest_load_1,
        last_sample_at=host.last_sample_at,
        created_at=host.created_at,
    )


def _apply_interval(host: ServerAuditHost, seconds: int) -> None:
    host.interval_seconds = seconds
    host.interval_minutes = minutes_mirror(seconds)


@router.get("/hosts", response_model=list[ServerAuditHostOut])
async def list_hosts(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    hosts = list(
        (
            await db.execute(
                select(ServerAuditHost)
                .options(defer(ServerAuditHost.notes))
                .order_by(ServerAuditHost.hostname.asc())
            )
        ).scalars().all()
    )
    ips = await _ips(db, hosts)
    return [_host_out(host, ips.get(host.computer_id or 0), with_notes=False) for host in hosts]


@router.post("/hosts", response_model=ServerAuditHostOut)
async def create_host(
    body: ServerAuditHostCreate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    hostname = _clean_hostname(body.hostname)
    existing = await find_audit_host(db, hostname)
    if existing is not None:
        raise HTTPException(status_code=409, detail="Такой хост уже есть в аудите")
    host = ServerAuditHost(
        hostname=hostname,
        label=_clip(body.label, 255),
        notes=_clip(body.notes, 4000),
        enabled=bool(body.enabled),
        interval_minutes=0,
        collect_requested=True,
    )
    _apply_interval(host, _clean_interval_seconds(body.interval_seconds, body.interval_minutes))
    db.add(host)
    await db.flush()
    await _link_computer(db, host, hostname)
    await db.commit()
    await db.refresh(host)
    ips = await _ips(db, [host])
    return _host_out(host, ips.get(host.computer_id or 0))


@router.patch("/hosts/{host_id}", response_model=ServerAuditHostOut)
async def update_host(
    host_id: int,
    body: ServerAuditHostUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    host = await _host_or_404(db, host_id)
    data = body.model_dump(exclude_unset=True)
    if "hostname" in data and data["hostname"] is not None:
        hostname = _clean_hostname(data["hostname"])
        other = await find_audit_host(db, hostname)
        if other is not None and other.id != host.id:
            raise HTTPException(status_code=409, detail="Такой хост уже есть в аудите")
        host.hostname = hostname
        await _link_computer(db, host, hostname)
    if "label" in data:
        host.label = _clip(data["label"], 255)
    if "notes" in data:
        host.notes = _clip(data["notes"], 4000)
    if data.get("interval_seconds") is not None or data.get("interval_minutes") is not None:
        if data.get("interval_seconds") is not None:
            seconds = _clean_interval_seconds(int(data["interval_seconds"]), None)
        else:
            seconds = _clean_interval_seconds(None, int(data["interval_minutes"]))
        _apply_interval(host, seconds)
    if "enabled" in data and data["enabled"] is not None:
        host.enabled = bool(data["enabled"])
    if "journal_mode" in data and data["journal_mode"] is not None:
        mode = str(data["journal_mode"]).strip().lower()
        if mode not in JOURNAL_MODES:
            raise HTTPException(status_code=400, detail="Журнал: выкл, ошибки или все")
        host.journal_mode = mode
    if "journal_lines" in data and data["journal_lines"] is not None:
        lines = int(data["journal_lines"])
        if lines not in JOURNAL_LINES:
            raise HTTPException(status_code=400, detail="Строк журнала: 0, 10, 20, 40 или 80")
        host.journal_lines = lines
    if "retain_days" in data and data["retain_days"] is not None:
        days = int(data["retain_days"])
        if days not in RETAIN_DAYS:
            raise HTTPException(status_code=400, detail="Хранение: 7, 14, 30 или 90 дней")
        host.retain_days = days
    if any(key in data for key in ("journal_mode", "journal_lines", "retain_days")):
        await apply_journal_now(db, host)
    await db.commit()
    await db.refresh(host)
    ips = await _ips(db, [host])
    return _host_out(host, ips.get(host.computer_id or 0))


@router.delete("/hosts/{host_id}")
async def delete_host(
    host_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    host = await _host_or_404(db, host_id)
    await db.delete(host)
    await db.commit()
    return {"ok": True}


@router.post("/hosts/{host_id}/collect", response_model=ServerAuditHostOut)
async def request_collect(
    host_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    host = await _host_or_404(db, host_id)
    if not host.enabled:
        raise HTTPException(status_code=400, detail="Хост выключен — включите его, чтобы запросить сбор")
    host.collect_requested = True
    await db.commit()
    await db.refresh(host)
    ips = await _ips(db, [host])
    return _host_out(host, ips.get(host.computer_id or 0))


@router.get("/hosts/{host_id}", response_model=ServerAuditDetail)
async def host_detail(
    host_id: int,
    hours: int = Query(default=24, ge=1, le=168),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    host = await _host_or_404(db, host_id)
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = await load_chart_samples(db, host.id, since, _POINT_CAP)
    latest = (
        await db.execute(
            select(ServerAuditSample)
            .where(ServerAuditSample.host_id == host.id)
            .order_by(ServerAuditSample.collected_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    # One stored sample must draw even when it sits outside 6h/24h/7d.
    chart_rows = rows or ([latest] if latest is not None else [])
    points = [
        ServerAuditPoint(
            collected_at=row.collected_at,
            cpu_temp_c=row.cpu_temp_c,
            gpu_temp_c=row.gpu_temp_c,
            cpu_used_percent=row.cpu_used_percent,
            load_1=row.load_1,
            mem_used_percent=row.mem_used_percent,
            swap_used_percent=row.swap_used_percent,
            disk_used_percent=row.disk_used_percent,
            net_rx_bps=row.net_rx_bps,
            net_tx_bps=row.net_tx_bps,
            uptime_sec=row.uptime_sec,
        )
        for row in chart_rows
    ]
    in_range = rows[-1] if rows else None
    raw_payload = getattr(latest, "payload_json", None) if latest is not None else None
    payload: dict = {}
    if raw_payload:
        try:
            parsed = json.loads(raw_payload)
        except json.JSONDecodeError:
            parsed = {}
        if isinstance(parsed, dict):
            payload = parsed
    ips = await _ips(db, [host])
    base = _host_out(host, ips.get(host.computer_id or 0))
    return ServerAuditDetail(
        **base.model_dump(),
        payload=payload,
        points=points,
        payload_in_range=in_range is not None or latest is None,
    )
