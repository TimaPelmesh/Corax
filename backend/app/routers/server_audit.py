"""Panel API for the Linux server-audit tab."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_editor_or_superuser, get_current_user
from app.database import get_db
from app.models import Computer, ServerAuditHost, ServerAuditSample, User
from app.schemas import (
    ServerAuditDetail,
    ServerAuditHostCreate,
    ServerAuditHostOut,
    ServerAuditHostUpdate,
    ServerAuditPoint,
)
from app.server_audit_store import ALLOWED_INTERVALS, _link_computer, find_audit_host

router = APIRouter(prefix="/server-audit", tags=["server-audit"])

_HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$")
_POINT_CAP = 800


def _clean_hostname(value: str) -> str:
    host = (value or "").strip().rstrip(".")
    if not _HOST_RE.match(host):
        raise HTTPException(status_code=400, detail="Имя хоста: буквы, цифры, точка, дефис")
    return host


def _clean_interval(value: int) -> int:
    if value not in ALLOWED_INTERVALS:
        raise HTTPException(status_code=400, detail="Интервал: вручную, 5, 15, 30, 60, 180, 360, 720 или 1440 минут")
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


def _host_out(host: ServerAuditHost, ip: str | None = None) -> ServerAuditHostOut:
    return ServerAuditHostOut(
        id=host.id,
        hostname=host.hostname,
        label=host.label,
        notes=host.notes,
        enabled=bool(host.enabled),
        interval_minutes=int(host.interval_minutes or 0),
        collect_requested=bool(host.collect_requested),
        computer_id=host.computer_id,
        ip_address=ip,
        os_summary=host.os_summary,
        latest_cpu_temp_c=host.latest_cpu_temp_c,
        latest_cpu_percent=host.latest_cpu_percent,
        latest_mem_percent=host.latest_mem_percent,
        latest_disk_percent=host.latest_disk_percent,
        latest_load_1=host.latest_load_1,
        last_sample_at=host.last_sample_at,
        created_at=host.created_at,
    )


def _downsample(rows: list[ServerAuditSample]) -> list[ServerAuditSample]:
    if len(rows) <= _POINT_CAP:
        return rows
    stride = (len(rows) + _POINT_CAP - 1) // _POINT_CAP
    picked = rows[::stride]
    if picked[-1] is not rows[-1]:
        picked.append(rows[-1])
    return picked


@router.get("/hosts", response_model=list[ServerAuditHostOut])
async def list_hosts(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    hosts = list(
        (await db.execute(select(ServerAuditHost).order_by(ServerAuditHost.hostname.asc()))).scalars().all()
    )
    ips = await _ips(db, hosts)
    return [_host_out(host, ips.get(host.computer_id or 0)) for host in hosts]


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
        interval_minutes=_clean_interval(int(body.interval_minutes)),
        collect_requested=True,
    )
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
    if "interval_minutes" in data and data["interval_minutes"] is not None:
        host.interval_minutes = _clean_interval(int(data["interval_minutes"]))
    if "enabled" in data and data["enabled"] is not None:
        host.enabled = bool(data["enabled"])
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
    rows = list(
        (
            await db.execute(
                select(ServerAuditSample)
                .where(ServerAuditSample.host_id == host.id, ServerAuditSample.collected_at >= since)
                .order_by(ServerAuditSample.collected_at.asc())
            )
        ).scalars().all()
    )
    points = [
        ServerAuditPoint(
            collected_at=row.collected_at,
            cpu_temp_c=row.cpu_temp_c,
            cpu_used_percent=row.cpu_used_percent,
            load_1=row.load_1,
            mem_used_percent=row.mem_used_percent,
            swap_used_percent=row.swap_used_percent,
            disk_used_percent=row.disk_used_percent,
            net_rx_bps=row.net_rx_bps,
            net_tx_bps=row.net_tx_bps,
            uptime_sec=row.uptime_sec,
        )
        for row in _downsample(rows)
    ]
    latest = (
        await db.execute(
            select(ServerAuditSample)
            .where(ServerAuditSample.host_id == host.id)
            .order_by(ServerAuditSample.collected_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    payload: dict = {}
    if latest and latest.payload_json:
        try:
            parsed = json.loads(latest.payload_json)
        except json.JSONDecodeError:
            parsed = {}
        if isinstance(parsed, dict):
            payload = parsed
    ips = await _ips(db, [host])
    base = _host_out(host, ips.get(host.computer_id or 0))
    return ServerAuditDetail(
        id=base.id,
        hostname=base.hostname,
        label=base.label,
        notes=base.notes,
        enabled=base.enabled,
        interval_minutes=base.interval_minutes,
        collect_requested=base.collect_requested,
        computer_id=base.computer_id,
        ip_address=base.ip_address,
        os_summary=base.os_summary,
        latest_cpu_temp_c=base.latest_cpu_temp_c,
        latest_cpu_percent=base.latest_cpu_percent,
        latest_mem_percent=base.latest_mem_percent,
        latest_disk_percent=base.latest_disk_percent,
        latest_load_1=base.latest_load_1,
        last_sample_at=base.last_sample_at,
        created_at=base.created_at,
        payload=payload,
        points=points,
    )
