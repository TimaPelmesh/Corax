from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_serializer
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_editor_or_superuser, get_current_user
from app.database import get_db
from app.models import Computer, Printer, User
from app.printer_cleanup import cleanup_printers_db, is_noise_printer_name, printer_dedupe_key_for_ip, snmp_tab_clause
from app.printer_poll import _discovery_concurrency, poll_single_printer, run_printer_poll_cycle
from app.printer_poll_config import get_effective_printer_poll_config, get_printer_poll_config_row
from app.printer_scheduler import printer_poll_scheduler
from app.printer_snmp_discover import discover_snmp_printers
import re

router = APIRouter(prefix="/printers", tags=["printers"])

_IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


class PrinterSupplyOut(BaseModel):
    name: str
    level_percent: int | None = None
    level_raw: int | None = None
    max_capacity: int | None = None


class PrinterOut(BaseModel):
    id: int
    name: str
    driver_name: str | None
    port_name: str | None
    ip_address: str | None
    is_network: bool
    is_shared: bool
    is_default: bool
    agent_status: str | None
    work_offline: bool | None
    poll_status: str | None
    computer_id: int | None
    computer_hostname: str | None = None
    location: str | None
    notes: str | None
    source: str
    snmp_model: str | None = None
    page_count: int | None = None
    supplies: list[PrinterSupplyOut] = []
    toner_min_percent: int | None = None
    last_seen_at: datetime | None
    last_poll_at: datetime | None
    last_snmp_at: datetime | None = None
    snmp_status: str | None = None
    snmp_error: str | None = None
    created_at: datetime | None
    updated_at: datetime | None

    @field_serializer(
        "last_seen_at",
        "last_poll_at",
        "last_snmp_at",
        "created_at",
        "updated_at",
    )
    def _ser_dt(self, v: datetime | None):
        # SQLite often returns naive datetimes even for timezone-aware columns.
        # Treat naive values as UTC to avoid visible -3h/+3h shifts in UI.
        if v is None:
            return None
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat().replace("+00:00", "Z")


class PrinterMapItem(BaseModel):
    """Lean printer row for building map bind/hover."""

    id: int
    name: str
    snmp_model: str | None = None
    ip_address: str | None = None
    location: str | None = None
    poll_status: str | None = None
    page_count: int | None = None
    toner_min_percent: int | None = None


class PrinterCreate(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    ip_address: str = Field(min_length=7, max_length=64)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = None


class PrinterPatch(BaseModel):
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = None
    ip_address: str | None = Field(default=None, max_length=64)


class PrinterPollResult(BaseModel):
    polled: int
    online: int
    offline: int
    skipped: int
    snmp_ok: int = 0
    snmp_error: int = 0
    duration_ms: int = 0
    triggered_by: str = "manual"
    total_in_db: int = 0
    with_ip: int = 0
    without_ip: int = 0
    discovered: int = 0
    discovery_created: int = 0
    discovery_updated: int = 0
    message: str = ""


class PrinterCleanupResultOut(BaseModel):
    deleted_noise: int
    deleted_no_ip: int
    deleted_duplicates: int
    keys_fixed: int
    remaining: int


class PrinterSnmpDiscoveryOut(BaseModel):
    scanned: int
    found: int
    created: int
    updated: int
    errors: int
    duration_ms: int
    networks: list[str]
    message: str


class PrinterBulkDelete(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)


class PrinterPollConfigOut(BaseModel):
    poll_enabled: bool
    poll_interval_minutes: int
    snmp_enabled: bool
    snmp_community: str
    snmp_community_set: bool = True
    snmp_timeout_seconds: float
    ping_timeout_ms: int
    poll_concurrency: int
    last_run_at: datetime | None = None

    @field_serializer("last_run_at")
    def _ser_last_run_at(self, v: datetime | None):
        if v is None:
            return None
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat().replace("+00:00", "Z")


class PrinterPollConfigUpdate(BaseModel):
    poll_enabled: bool | None = None
    poll_interval_minutes: int | None = Field(default=None, ge=1, le=1440)
    snmp_enabled: bool | None = None
    snmp_community: str | None = Field(default=None, max_length=128)
    snmp_timeout_seconds: float | None = Field(default=None, ge=1.0, le=60.0)
    ping_timeout_ms: int | None = Field(default=None, ge=300, le=10000)
    poll_concurrency: int | None = Field(default=None, ge=1, le=32)


class PrinterSchedulerStatusOut(BaseModel):
    scheduler_active: bool
    running_now: bool
    poll_enabled: bool
    poll_interval_minutes: int
    next_run_at: str | None = None
    last_run_at: str | None = None
    last_run_summary: dict[str, Any] | None = None


def _validate_ip(ip: str | None) -> str | None:
    if not ip:
        return None
    s = ip.strip()
    if not _IP_RE.match(s):
        raise HTTPException(status_code=400, detail="Некорректный IP-адрес")
    parts = s.split(".")
    if not all(0 <= int(p) <= 255 for p in parts):
        raise HTTPException(status_code=400, detail="Некорректный IP-адрес")
    return s


def _parse_supplies(raw: str | None) -> list[PrinterSupplyOut]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[PrinterSupplyOut] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        out.append(
            PrinterSupplyOut(
                name=name,
                level_percent=item.get("level_percent"),
                level_raw=item.get("level_raw"),
                max_capacity=item.get("max_capacity"),
            )
        )
    return out


def _toner_min_percent(supplies: list[PrinterSupplyOut]) -> int | None:
    vals = [s.level_percent for s in supplies if s.level_percent is not None]
    if not vals:
        return None
    return int(min(vals))


def _printer_out(row: Printer, hostname: str | None = None) -> PrinterOut:
    supplies = _parse_supplies(row.supplies_json)
    return PrinterOut(
        id=row.id,
        name=row.name,
        driver_name=row.driver_name,
        port_name=row.port_name,
        ip_address=row.ip_address,
        is_network=bool(row.is_network),
        is_shared=bool(row.is_shared),
        is_default=bool(row.is_default),
        agent_status=row.agent_status,
        work_offline=row.work_offline,
        poll_status=row.poll_status,
        computer_id=row.computer_id,
        computer_hostname=hostname,
        location=row.location,
        notes=row.notes,
        source=row.source or "manual",
        snmp_model=row.snmp_model,
        page_count=row.page_count,
        supplies=supplies,
        toner_min_percent=_toner_min_percent(supplies),
        last_seen_at=row.last_seen_at,
        last_poll_at=row.last_poll_at,
        last_snmp_at=row.last_snmp_at,
        snmp_status=row.snmp_status,
        snmp_error=row.snmp_error,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _hostnames_map(db: AsyncSession, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    r = await db.execute(select(Computer.id, Computer.hostname).where(Computer.id.in_(ids)))
    return {int(i): h for i, h in r.all()}


@router.post("/cleanup", response_model=PrinterCleanupResultOut)
async def cleanup_printers(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    r = await cleanup_printers_db(db)
    return PrinterCleanupResultOut(
        deleted_noise=r.deleted_noise,
        deleted_no_ip=r.deleted_no_ip,
        deleted_duplicates=r.deleted_duplicates,
        keys_fixed=r.keys_fixed,
        remaining=r.remaining,
    )


@router.post("/discover-snmp", response_model=PrinterSnmpDiscoveryOut)
async def discover_printers_snmp(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    cfg = await get_effective_printer_poll_config(db)
    r = await discover_snmp_printers(
        db,
        community=cfg.snmp_community,
        timeout=min(2.0, max(0.8, cfg.snmp_timeout_seconds)),
        total_budget_seconds=30.0,
        concurrency=_discovery_concurrency(cfg),
    )
    return PrinterSnmpDiscoveryOut(
        scanned=r.scanned,
        found=r.found,
        created=r.created,
        updated=r.updated,
        errors=r.errors,
        duration_ms=r.duration_ms,
        networks=r.networks,
        message=r.message,
    )


@router.get("/poll-config", response_model=PrinterPollConfigOut)
async def get_poll_config(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = await get_printer_poll_config_row(db)
    return PrinterPollConfigOut(
        poll_enabled=bool(row.poll_enabled),
        poll_interval_minutes=int(row.poll_interval_minutes),
        snmp_enabled=bool(row.snmp_enabled),
        snmp_community=(row.snmp_community or "public").strip() or "public",
        snmp_community_set=bool((row.snmp_community or "").strip()),
        snmp_timeout_seconds=float(row.snmp_timeout_seconds or 5.0),
        ping_timeout_ms=int(row.ping_timeout_ms or 1200),
        poll_concurrency=int(row.poll_concurrency or 6),
        last_run_at=row.last_run_at,
    )


@router.put("/poll-config", response_model=PrinterPollConfigOut)
async def update_poll_config(
    body: PrinterPollConfigUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await get_printer_poll_config_row(db)
    if body.poll_enabled is not None:
        row.poll_enabled = bool(body.poll_enabled)
    if body.poll_interval_minutes is not None:
        row.poll_interval_minutes = int(body.poll_interval_minutes)
    if body.snmp_enabled is not None:
        row.snmp_enabled = bool(body.snmp_enabled)
    if body.snmp_community is not None:
        row.snmp_community = body.snmp_community.strip() or "public"
    if body.snmp_timeout_seconds is not None:
        row.snmp_timeout_seconds = float(body.snmp_timeout_seconds)
    if body.ping_timeout_ms is not None:
        row.ping_timeout_ms = int(body.ping_timeout_ms)
    if body.poll_concurrency is not None:
        row.poll_concurrency = int(body.poll_concurrency)
    await db.commit()
    await db.refresh(row)
    printer_poll_scheduler.wake()
    return PrinterPollConfigOut(
        poll_enabled=bool(row.poll_enabled),
        poll_interval_minutes=int(row.poll_interval_minutes),
        snmp_enabled=bool(row.snmp_enabled),
        snmp_community=(row.snmp_community or "public").strip() or "public",
        snmp_community_set=bool((row.snmp_community or "").strip()),
        snmp_timeout_seconds=float(row.snmp_timeout_seconds or 5.0),
        ping_timeout_ms=int(row.ping_timeout_ms or 1200),
        poll_concurrency=int(row.poll_concurrency or 6),
        last_run_at=row.last_run_at,
    )


@router.get("/scheduler-status", response_model=PrinterSchedulerStatusOut)
async def scheduler_status(_: User = Depends(get_current_user)):
    data = await printer_poll_scheduler.status()
    return PrinterSchedulerStatusOut(**data)


@router.get("")
async def list_printers(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    q: str | None = Query(default=None),
    poll_status: str | None = Query(default=None),
    limit: int = Query(default=2000, ge=1, le=5000),
    view: str = Query(default="full", description="full | map"),
):
    from typing import Literal

    view_norm: Literal["full", "map"] = "map" if (view or "").strip().lower() == "map" else "full"

    if view_norm == "map":
        stmt = select(
            Printer.id,
            Printer.name,
            Printer.snmp_model,
            Printer.ip_address,
            Printer.location,
            Printer.poll_status,
            Printer.page_count,
            Printer.supplies_json,
        ).where(snmp_tab_clause()).order_by(Printer.name.asc(), Printer.id.asc())
    else:
        stmt = select(Printer).where(snmp_tab_clause()).order_by(Printer.name.asc(), Printer.id.asc())
    if poll_status:
        if view_norm == "map":
            stmt = stmt.where(Printer.poll_status == poll_status.strip())
        else:
            stmt = stmt.where(Printer.poll_status == poll_status.strip())
    if q and q.strip():
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Printer.name).like(needle),
                func.lower(func.coalesce(Printer.ip_address, "")).like(needle),
                func.lower(func.coalesce(Printer.driver_name, "")).like(needle),
                func.lower(func.coalesce(Printer.port_name, "")).like(needle),
                func.lower(func.coalesce(Printer.location, "")).like(needle),
                func.lower(func.coalesce(Printer.snmp_model, "")).like(needle),
            )
        )
    if view_norm == "map":
        rows = (await db.execute(stmt.limit(limit))).all()
        out: list[PrinterMapItem] = []
        for row in rows:
            supplies = _parse_supplies(row.supplies_json)
            out.append(
                PrinterMapItem(
                    id=int(row.id),
                    name=row.name,
                    snmp_model=row.snmp_model,
                    ip_address=row.ip_address,
                    location=row.location,
                    poll_status=row.poll_status,
                    page_count=row.page_count,
                    toner_min_percent=_toner_min_percent(supplies),
                )
            )
        return out

    rows = (await db.execute(stmt.limit(limit))).scalars().all()
    pc_ids = {r.computer_id for r in rows if r.computer_id}
    hosts = await _hostnames_map(db, pc_ids)
    return [_printer_out(r, hosts.get(r.computer_id) if r.computer_id else None) for r in rows]


@router.post("", response_model=PrinterOut)
async def create_printer(
    body: PrinterCreate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    name = body.name.strip()
    if is_noise_printer_name(name):
        raise HTTPException(status_code=400, detail="Такое имя не подходит (виртуальный/служебный принтер)")
    ip = _validate_ip(body.ip_address)
    if not ip:
        raise HTTPException(status_code=400, detail="Укажите IP-адрес принтера")
    dedupe_key = printer_dedupe_key_for_ip(ip)
    dup = await db.scalar(select(Printer.id).where(Printer.dedupe_key == dedupe_key).limit(1))
    if not dup:
        dup = await db.scalar(select(Printer.id).where(Printer.ip_address == ip).limit(1))
    if dup:
        raise HTTPException(status_code=409, detail=f"Принтер с IP {ip} уже есть")
    row = Printer(
        dedupe_key=dedupe_key,
        name=name[:512],
        ip_address=ip,
        location=(body.location or "").strip()[:255] or None,
        notes=(body.notes or "").strip() or None,
        is_network=True,
        source="manual",
        poll_status="unknown",
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _printer_out(row)


@router.patch("/{printer_id}", response_model=PrinterOut)
async def patch_printer(
    printer_id: int,
    body: PrinterPatch,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Принтер не найден")
    if body.location is not None:
        row.location = body.location.strip()[:255] or None
    if body.notes is not None:
        row.notes = body.notes.strip() or None
    if body.ip_address is not None:
        ip = _validate_ip(body.ip_address)
        if not ip:
            raise HTTPException(status_code=400, detail="Укажите IP-адрес")
        other = await db.scalar(
            select(Printer.id).where(Printer.ip_address == ip, Printer.id != row.id).limit(1)
        )
        if other:
            raise HTTPException(status_code=409, detail=f"IP {ip} уже занят другим принтером")
        row.ip_address = ip
        row.dedupe_key = printer_dedupe_key_for_ip(ip)
        row.is_network = True
    await db.commit()
    await db.refresh(row)
    hostname = None
    if row.computer_id:
        hostname = await db.scalar(select(Computer.hostname).where(Computer.id == row.computer_id))
    return _printer_out(row, hostname)


@router.delete("/{printer_id}", status_code=204)
async def delete_printer(
    printer_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Принтер не найден")
    await db.delete(row)
    await db.commit()


@router.post("/bulk-delete", status_code=204)
async def bulk_delete_printers(
    body: PrinterBulkDelete,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    ids = sorted({int(i) for i in body.ids if int(i) > 0})
    if not ids:
        raise HTTPException(status_code=400, detail="Список ID пуст")
    rows = (await db.execute(select(Printer).where(Printer.id.in_(ids)))).scalars().all()
    if not rows:
        raise HTTPException(status_code=404, detail="Принтеры не найдены")
    for row in rows:
        await db.delete(row)
    await db.commit()


@router.post("/poll", response_model=PrinterPollResult)
async def poll_all_printers(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    stats = await run_printer_poll_cycle(db, triggered_by="manual")
    return PrinterPollResult(
        polled=stats.polled,
        online=stats.online,
        offline=stats.offline,
        skipped=stats.skipped,
        snmp_ok=stats.snmp_ok,
        snmp_error=stats.snmp_error,
        duration_ms=stats.duration_ms,
        triggered_by=stats.triggered_by,
        total_in_db=stats.total_in_db,
        with_ip=stats.with_ip,
        without_ip=stats.without_ip,
        discovered=stats.discovered,
        discovery_created=stats.discovery_created,
        discovery_updated=stats.discovery_updated,
        message=stats.message,
    )


@router.post("/{printer_id}/poll", response_model=PrinterOut)
async def poll_printer(
    printer_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Принтер не найден")
    ip = (row.ip_address or "").strip()
    if not ip:
        raise HTTPException(status_code=400, detail="У принтера нет IP для опроса")
    cfg = await get_effective_printer_poll_config(db)
    await poll_single_printer(row, cfg)
    await db.commit()
    await db.refresh(row)
    hostname = None
    if row.computer_id:
        hostname = await db.scalar(select(Computer.hostname).where(Computer.id == row.computer_id))
    return _printer_out(row, hostname)
