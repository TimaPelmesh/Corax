from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_serializer
from sqlalchemy import delete, func, insert, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_current_user, get_current_editor_or_superuser, get_current_superuser
from app.computer_ip import resolve_computer_ipv4
from app.config import settings
from app.database import get_db
from app.models import (
    AssetChangeLog,
    DiskVolume,
    Peripheral,
    Computer,
    InstalledSoftware,
    Tag,
    User,
    computer_tags,
)
from app.peripheral_display import prepare_peripherals_for_display
from app.printer_poll import ping_ip
from app.rate_limit import limiter
from app.schemas import (
    ComputerDetail,
    ComputerMapItem,
    ComputerOut,
    ComputerUpdate,
    DiskVolume as DiskVolumeOut,
    PeripheralItem,
    SoftwareItem,
    TagBrief,
)
from app.wol import format_mac, normalize_mac, send_wake
from app.wol_config import (
    check_cooldown,
    get_effective_wol_config,
    get_wol_config_row,
    mark_woken,
    serialize_id_list,
    user_may_wake,
)
import csv
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
_DRIVE_LETTER_RE = re.compile(r"^[A-Za-z]:$")


def _agent_extended_from_raw(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    ext = data.get("extended")
    return ext if isinstance(ext, dict) else None



async def _tags_for_computer(db: AsyncSession, computer_id: int) -> list[TagBrief]:
    """Без обхода ORM-коллекции .tags (в asyncio это даёт MissingGreenlet)."""
    r = await db.execute(
        select(Tag.id, Tag.name, Tag.color)
        .join(computer_tags, Tag.id == computer_tags.c.tag_id)
        .where(computer_tags.c.computer_id == computer_id)
        .order_by(Tag.name.asc())
    )
    return [TagBrief(id=int(row[0]), name=str(row[1]), color=row[2]) for row in r.all()]


async def _tags_for_computers_bulk(db: AsyncSession, computer_ids: list[int]) -> dict[int, list[TagBrief]]:
    if not computer_ids:
        return {}
    r = await db.execute(
        select(computer_tags.c.computer_id, Tag.id, Tag.name, Tag.color)
        .join(Tag, Tag.id == computer_tags.c.tag_id)
        .where(computer_tags.c.computer_id.in_(computer_ids))
        .order_by(computer_tags.c.computer_id.asc(), Tag.name.asc())
    )
    out: dict[int, list[TagBrief]] = {cid: [] for cid in computer_ids}
    for cid, tid, tname, tcolor in r.all():
        out[int(cid)].append(TagBrief(id=int(tid), name=str(tname), color=tcolor))
    return out

router = APIRouter(prefix="/computers", tags=["computers"])


class WolConfigOut(BaseModel):
    enabled: bool
    force_disabled: bool
    allowlist_computer_ids: list[int]
    wake_user_ids: list[int]
    cooldown_seconds: int


class WolConfigUpdate(BaseModel):
    enabled: bool | None = None
    allowlist_computer_ids: list[int] | None = None
    wake_user_ids: list[int] | None = None
    cooldown_seconds: int | None = Field(default=None, ge=0, le=3600)


class WolAllowUpdate(BaseModel):
    allowed: bool


class WolStatusOut(BaseModel):
    enabled: bool
    force_disabled: bool
    allowlisted: bool
    user_may_wake: bool
    has_mac: bool
    cooldown_remaining_seconds: int | None = None
    can_wake: bool


class WolWakeOut(BaseModel):
    ok: bool
    computer_id: int
    hostname: str
    mac: str
    sent: int
    message: str


class ComputerPingOut(BaseModel):
    computer_id: int
    hostname: str
    ip_address: str | None
    online: bool | None
    checked: bool
    message: str


class ComputerPingStatusItem(BaseModel):
    id: int
    ping_status: str | None = None
    last_ping_at: datetime | None = None
    ip_address: str | None = None

    @field_serializer("last_ping_at")
    def _ser_last_ping_at(self, v: datetime | None):
        if v is None:
            return None
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat().replace("+00:00", "Z")


class ComputerPingStatusOut(BaseModel):
    items: list[ComputerPingStatusItem]
    sweep: dict | None = None


def _wol_config_out(cfg) -> WolConfigOut:
    return WolConfigOut(
        enabled=cfg.enabled,
        force_disabled=cfg.force_disabled,
        allowlist_computer_ids=cfg.allowlist,
        wake_user_ids=cfg.wake_user_ids,
        cooldown_seconds=cfg.cooldown_seconds,
    )


def _resolve_computer_ip(c: Computer) -> str | None:
    return resolve_computer_ipv4(
        ip_address=getattr(c, "ip_address", None),
        hostname=c.hostname,
        mac_primary=c.mac_primary,
        raw_payload=c.raw_payload,
    )


async def _wol_status_for(db: AsyncSession, c: Computer, user: User) -> WolStatusOut:
    cfg = await get_effective_wol_config(db)
    may = user_may_wake(user, cfg)
    has_mac = bool((c.mac_primary or "").strip())
    if has_mac:
        try:
            normalize_mac(c.mac_primary)
        except ValueError:
            has_mac = False
    cool = check_cooldown(c.id, cfg.cooldown_seconds) if cfg.enabled and may else None
    # Allowlist retired for now: any PC with MAC may be woken by granted operators.
    can_wake = bool(cfg.enabled and may and has_mac and cool is None)
    return WolStatusOut(
        enabled=cfg.enabled,
        force_disabled=cfg.force_disabled,
        allowlisted=True,
        user_may_wake=may,
        has_mac=has_mac,
        cooldown_remaining_seconds=cool,
        can_wake=can_wake,
    )


@router.get("/ping-status", response_model=ComputerPingStatusOut)
async def computers_ping_status(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    kick: bool = Query(False, description="Start a batched sweep if many unknown or stale ping caches"),
):
    """Lightweight ping cache for live list indicators (no ICMP in this call)."""
    r = await db.execute(
        select(Computer.id, Computer.ping_status, Computer.last_ping_at, Computer.ip_address).order_by(
            Computer.id.asc()
        )
    )
    items = [
        ComputerPingStatusItem(
            id=int(row[0]),
            ping_status=(str(row[1]).strip().lower() if row[1] else None),
            last_ping_at=row[2],
            ip_address=(str(row[3]).strip() if row[3] else None),
        )
        for row in r.all()
    ]
    sweep = None
    if kick:
        # Kick when many are unknown OR many known statuses are stale (wrong online/offline
        # until drip catches them — UI should not wait for a manual open-detail ping).
        from datetime import datetime, timedelta, timezone

        from app.computer_ping_scheduler import computer_ping_scheduler
        from app.config import settings

        now = datetime.now(timezone.utc)
        stale_after = timedelta(
            minutes=max(2, min(5, int(getattr(settings, "computer_ping_interval_minutes", 15)) // 3))
        )
        unknown = 0
        stale = 0
        for it in items:
            st = (it.ping_status or "").strip().lower()
            if not st or st == "unknown":
                unknown += 1
            ts = it.last_ping_at
            if ts is None:
                stale += 1
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if now - ts > stale_after:
                stale += 1
        need = max(1, len(items) // 4) if items else 1
        if not items or unknown >= need or stale >= need:
            sweep = computer_ping_scheduler.request_full(reason="ui")
    return ComputerPingStatusOut(items=items, sweep=sweep)


@router.post("/ping-sweep")
async def computers_ping_sweep(_: User = Depends(get_current_user)):
    """Kick a careful batched full sweep (non-blocking)."""
    from app.computer_ping_scheduler import computer_ping_scheduler

    return computer_ping_scheduler.request_full(reason="ui")


@router.get("/wol/config", response_model=WolConfigOut)
async def get_wol_config(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    return _wol_config_out(await get_effective_wol_config(db))


@router.put("/wol/config", response_model=WolConfigOut)
async def put_wol_config(
    body: WolConfigUpdate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await get_wol_config_row(db)
    if body.enabled is not None:
        row.enabled = bool(body.enabled)
    if body.allowlist_computer_ids is not None:
        ids = list(dict.fromkeys(int(x) for x in body.allowlist_computer_ids if int(x) > 0))[:500]
        if ids:
            found = (
                await db.execute(select(Computer.id).where(Computer.id.in_(ids)))
            ).scalars().all()
            found_set = {int(x) for x in found}
            missing = [i for i in ids if i not in found_set]
            if missing:
                raise HTTPException(
                    status_code=400,
                    detail=f"Неизвестные ПК в allowlist: {', '.join(str(x) for x in missing[:20])}",
                )
        row.allowlist_computer_ids_json = serialize_id_list(ids)
    if body.wake_user_ids is not None:
        uids = list(dict.fromkeys(int(x) for x in body.wake_user_ids if int(x) > 0))[:200]
        if uids:
            found = (await db.execute(select(User.id).where(User.id.in_(uids)))).scalars().all()
            found_set = {int(x) for x in found}
            missing = [i for i in uids if i not in found_set]
            if missing:
                raise HTTPException(
                    status_code=400,
                    detail=f"Неизвестные пользователи: {', '.join(str(x) for x in missing[:20])}",
                )
        row.wake_user_ids_json = serialize_id_list(uids)
    if body.cooldown_seconds is not None:
        row.cooldown_seconds = int(body.cooldown_seconds)
    await db.commit()
    return _wol_config_out(await get_effective_wol_config(db))


@router.get("")
async def list_computers(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    skip: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=5000),
    q: str | None = Query(None),
    tag_ids: list[int] = Query(default=[]),
    view: Literal["list", "map", "full"] = Query(
        "list",
        description="list/full: table rows without loading raw_payload; map: minimal bind fields",
    ),
    ping_status: str | None = Query(
        None,
        description="Filter: online | offline | unknown",
    ),
    sort: Literal["last", "host", "ram", "periph"] = Query("last"),
    sort_dir: Literal["asc", "desc"] = Query("desc"),
):
    """Fleet list. Never materializes raw_payload/disks_json for list/map views."""
    sq_sw = (
        select(InstalledSoftware.computer_id, func.count().label("cnt"))
        .group_by(InstalledSoftware.computer_id)
        .subquery()
    )
    sq_pe = (
        select(Peripheral.computer_id, func.count().label("cnt"))
        .group_by(Peripheral.computer_id)
        .subquery()
    )

    # Column subset — excludes Text blobs (raw_payload, disks_json).
    cols = [
        Computer.id,
        Computer.hostname,
        Computer.serial_number,
        Computer.mac_primary,
        Computer.ip_address,
        Computer.ping_status,
        Computer.last_ping_at,
        Computer.cpu,
        Computer.ram_gb,
        Computer.os_name,
        Computer.os_version,
        Computer.manufacturer,
        Computer.model,
        Computer.location,
        Computer.gpu_name,
        Computer.memory_used_percent,
        Computer.motherboard_manufacturer,
        Computer.motherboard_product,
        Computer.last_report_at,
        Computer.notes,
        Computer.assigned_user_id,
        func.coalesce(sq_sw.c.cnt, 0).label("software_count"),
        func.coalesce(sq_pe.c.cnt, 0).label("peripheral_count"),
    ]
    stmt = (
        select(*cols)
        .outerjoin(sq_sw, Computer.id == sq_sw.c.computer_id)
        .outerjoin(sq_pe, Computer.id == sq_pe.c.computer_id)
    )
    if q and q.strip():
        stmt = stmt.where(Computer.hostname.ilike(f"%{q.strip()}%"))
    if tag_ids:
        stmt = stmt.join(computer_tags, computer_tags.c.computer_id == Computer.id).where(
            computer_tags.c.tag_id.in_(tag_ids)
        )
    pst_filter = (ping_status or "").strip().lower()
    if pst_filter == "online":
        stmt = stmt.where(func.lower(func.coalesce(Computer.ping_status, "")) == "online")
    elif pst_filter == "offline":
        stmt = stmt.where(func.lower(func.coalesce(Computer.ping_status, "")) == "offline")
    elif pst_filter == "unknown":
        stmt = stmt.where(
            or_(
                Computer.ping_status.is_(None),
                func.lower(Computer.ping_status) == "unknown",
                ~func.lower(func.coalesce(Computer.ping_status, "")).in_(("online", "offline")),
            )
        )

    total = int(
        await db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    )

    asc = sort_dir == "asc"
    if sort == "host":
        order_col = Computer.hostname
    elif sort == "ram":
        order_col = Computer.ram_gb
    elif sort == "periph":
        order_col = func.coalesce(sq_pe.c.cnt, 0)
    else:
        order_col = Computer.last_report_at
    order_expr = order_col.asc().nulls_last() if asc else order_col.desc().nulls_last()
    stmt = stmt.order_by(order_expr, Computer.id).offset(skip).limit(limit)
    r = await db.execute(stmt)
    rows = r.all()
    ids = [int(row.id) for row in rows]

    if view == "map":
        items = [
            ComputerMapItem(
                id=int(row.id),
                hostname=row.hostname,
                serial_number=row.serial_number,
                model=row.model,
                os_name=row.os_name,
                ram_gb=row.ram_gb,
                ip_address=row.ip_address,
                ping_status=(str(row.ping_status).strip().lower() if row.ping_status else None),
                last_ping_at=row.last_ping_at,
            )
            for row in rows
        ]
        return {"items": items, "total": total}

    tags_by_pc = await _tags_for_computers_bulk(db, ids)
    out: list[ComputerOut] = []
    for row in rows:
        out.append(
            ComputerOut(
                id=int(row.id),
                hostname=row.hostname,
                serial_number=row.serial_number,
                mac_primary=row.mac_primary,
                ip_address=row.ip_address,
                ping_status=(str(row.ping_status).strip().lower() if row.ping_status else None),
                last_ping_at=row.last_ping_at,
                cpu=row.cpu,
                ram_gb=row.ram_gb,
                os_name=row.os_name,
                os_version=row.os_version,
                manufacturer=row.manufacturer,
                model=row.model,
                location=row.location,
                gpu_name=row.gpu_name,
                memory_used_percent=row.memory_used_percent,
                motherboard_manufacturer=row.motherboard_manufacturer,
                motherboard_product=row.motherboard_product,
                disks=[],
                last_report_at=row.last_report_at,
                notes=row.notes,
                assigned_user_id=row.assigned_user_id,
                software_count=int(row.software_count),
                peripheral_count=int(row.peripheral_count),
                tags=tags_by_pc.get(int(row.id), []),
            )
        )
    return {"items": out, "total": total}


def _csv_dt(v: datetime | None) -> str:
    if v is None:
        return ""
    if v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v.isoformat().replace("+00:00", "Z")


@router.get("/export.csv")
async def export_computers_csv(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    q: str | None = Query(None),
    tag_ids: list[int] = Query(default=[]),
):
    data = await list_computers(
        _,
        db,
        skip=0,
        limit=5000,
        q=q,
        tag_ids=tag_ids,
        view="list",
        ping_status=None,
        sort="last",
        sort_dir="desc",
    )
    buf = io.StringIO()
    wr = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    wr.writerow(
        [
            "id",
            "hostname",
            "location",
            "tags",
            "os_name",
            "os_version",
            "manufacturer",
            "model",
            "cpu",
            "ram_gb",
            "software_count",
            "peripheral_count",
            "last_report_at",
            "serial_number",
            "mac_primary",
            "notes",
            "assigned_user_id",
        ]
    )
    for r in data["items"]:
        tags = ", ".join(t.name for t in (r.tags or []))
        wr.writerow(
            [
                r.id,
                r.hostname or "",
                r.location or "",
                tags,
                r.os_name or "",
                r.os_version or "",
                r.manufacturer or "",
                r.model or "",
                r.cpu or "",
                r.ram_gb if r.ram_gb is not None else "",
                r.software_count,
                r.peripheral_count,
                _csv_dt(r.last_report_at),
                r.serial_number or "",
                r.mac_primary or "",
                (r.notes or "").replace("\r\n", "\n").replace("\r", "\n"),
                r.assigned_user_id if r.assigned_user_id is not None else "",
            ]
        )
    body = "\ufeff" + buf.getvalue()
    return StreamingResponse(
        iter([body.encode("utf-8")]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=computers_export.csv"},
    )


_GLPI_PC_REQUIRED_HEADERS = [
    "Наименование",
    "Организация",
    "Статус",
    "Производитель",
    "Модель",
    "Операционная система - Наименование",
    "Инвентарный номер",
    "Тип",
    "Последнее изменение",
    "Компоненты - Процессоры",
]
_GLPI_PC_DT_FMT = "%d-%m-%Y %H:%M"


def _parse_glpi_pc_dt(v: str | None) -> datetime | None:
    t = (v or "").strip()
    if not t:
        return None
    try:
        return datetime.strptime(t, _GLPI_PC_DT_FMT)
    except Exception:
        return None


def _read_text_best_effort(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    raise ValueError("Не удалось прочитать CSV (кодировка). Попробуйте UTF-8 или Windows-1251.")


@router.get("/export-glpi-pcs.csv")
async def export_glpi_pcs_csv(_: User = Depends(get_current_user)):
    """
    Export normalized list of PCs from a GLPI CSV file on the server filesystem.

    Expected source file location:
    - <project_root>/glpi_pcs.csv
    """
    project_root = Path(__file__).resolve().parents[3]
    src = project_root / "glpi_pcs.csv"
    if not src.is_file():
        raise HTTPException(
            status_code=404,
            detail="GLPI CSV с ПК не найден. Положите файл в корень проекта как glpi_pcs.csv.",
        )

    try:
        raw = src.read_bytes()
        text = _read_text_best_effort(raw)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Не удалось прочитать GLPI CSV: {exc}") from exc

    reader = csv.DictReader(text.splitlines(), delimiter=";", quotechar='"')
    headers = reader.fieldnames or []
    missing = [h for h in _GLPI_PC_REQUIRED_HEADERS if h not in headers]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"CSV не похож на GLPI (ПК): нет колонок: {', '.join(missing)}",
        )

    # Aggregate by hostname/device name: keep latest 'Последнее изменение' and the most informative non-empty fields.
    agg: dict[str, dict] = {}
    for row in reader:
        name = (row.get("Наименование") or "").strip()
        if not name:
            continue
        key = name.strip()
        dt = _parse_glpi_pc_dt(row.get("Последнее изменение"))
        cur = agg.get(key)
        if cur is None:
            cur = {
                "name": key,
                "org": None,
                "status": None,
                "manufacturer": None,
                "model": None,
                "os": None,
                "inv": None,
                "type": None,
                "last_change": None,
                "cpu": None,
            }
            agg[key] = cur

        prev_dt = cur.get("last_change")
        if prev_dt is None or (dt is not None and prev_dt is not None and dt > prev_dt) or (dt is not None and prev_dt is None):
            cur["last_change"] = dt

        def pick(field_key: str, source_col: str):
            v = (row.get(source_col) or "").strip()
            if not v:
                return
            if cur.get(field_key) is None or cur.get(field_key) == "":
                cur[field_key] = v
            # If current is "unknown-ish", replace with a better one.
            if isinstance(cur.get(field_key), str):
                low = str(cur[field_key]).strip().lower()
                if low in ("default string", "???"):
                    cur[field_key] = v

        pick("org", "Организация")
        pick("status", "Статус")
        pick("manufacturer", "Производитель")
        pick("model", "Модель")
        pick("os", "Операционная система - Наименование")
        pick("inv", "Инвентарный номер")
        pick("type", "Тип")
        pick("cpu", "Компоненты - Процессоры")

    buf = io.StringIO()
    wr = csv.writer(buf, delimiter=";")
    wr.writerow(
        [
            "hostname",
            "organization",
            "status",
            "manufacturer",
            "model",
            "os_name",
            "inventory_number",
            "type",
            "last_change",
            "cpu",
        ]
    )
    for k in sorted(agg.keys(), key=lambda s: s.lower()):
        r = agg[k]
        dt = r.get("last_change")
        wr.writerow(
            [
                r.get("name") or "",
                r.get("org") or "",
                r.get("status") or "",
                r.get("manufacturer") or "",
                r.get("model") or "",
                r.get("os") or "",
                r.get("inv") or "",
                r.get("type") or "",
                dt.strftime(_GLPI_PC_DT_FMT) if isinstance(dt, datetime) else "",
                r.get("cpu") or "",
            ]
        )

    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=glpi_pcs_export.csv"},
    )


@router.get("/{computer_id}/software", response_model=list[SoftwareItem])
async def get_computer_software(
    computer_id: int,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    exists = await db.execute(select(Computer.id).where(Computer.id == computer_id))
    if exists.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="ПК не найден")
    rd = await db.execute(
        select(InstalledSoftware.name, InstalledSoftware.version)
        .where(InstalledSoftware.computer_id == computer_id)
        .order_by(InstalledSoftware.name.asc())
    )
    return [SoftwareItem(name=str(n), version=v) for n, v in rd.all()]


@router.get("/{computer_id}", response_model=ComputerDetail)
async def get_computer(
    computer_id: int,
    include_software: bool = Query(
        True,
        description="Если false — без списка ПО (быстрее); список: GET …/software",
    ),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    load_opts = [selectinload(Computer.peripherals)]
    if include_software:
        load_opts.insert(0, selectinload(Computer.software))
    r = await db.execute(
        select(Computer).options(*load_opts).where(Computer.id == computer_id)
    )
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="ПК не найден")
    if include_software:
        sw = [SoftwareItem(name=s.name, version=s.version) for s in c.software]
        cnt = len(sw)
    else:
        sw = []
        cnt_r = await db.execute(
            select(func.count())
            .select_from(InstalledSoftware)
            .where(InstalledSoftware.computer_id == computer_id)
        )
        cnt = int(cnt_r.scalar_one() or 0)
    pe = [
        PeripheralItem(kind=k, name=n)
        for k, n in prepare_peripherals_for_display([(p.kind, p.name) for p in c.peripherals])
    ]
    rd = await db.execute(select(DiskVolume).where(DiskVolume.computer_id == computer_id))
    disks = [
        DiskVolumeOut(
            mount=d.mount,
            label=d.label,
            total_gb=d.total_gb,
            used_percent=d.used_percent,
            free_gb=d.free_gb,
        )
        for d in rd.scalars().all()
        if isinstance(d.mount, str) and _DRIVE_LETTER_RE.match(d.mount)
    ]
    tags = await _tags_for_computer(db, computer_id)
    return ComputerDetail(
        id=c.id,
        hostname=c.hostname,
        serial_number=c.serial_number,
        mac_primary=c.mac_primary,
        ip_address=getattr(c, "ip_address", None) or _resolve_computer_ip(c),
        ping_status=getattr(c, "ping_status", None),
        last_ping_at=getattr(c, "last_ping_at", None),
        cpu=c.cpu,
        ram_gb=c.ram_gb,
        os_name=c.os_name,
        os_version=c.os_version,
        manufacturer=c.manufacturer,
        model=c.model,
        location=c.location,
        gpu_name=c.gpu_name,
        memory_used_percent=c.memory_used_percent,
        motherboard_manufacturer=c.motherboard_manufacturer,
        motherboard_product=c.motherboard_product,
        disks=disks,
        last_report_at=c.last_report_at,
        notes=c.notes,
        assigned_user_id=c.assigned_user_id,
        software_count=cnt,
        peripheral_count=len(pe),
        software=sw,
        peripherals=pe,
        tags=tags,
        agent_extended=_agent_extended_from_raw(c.raw_payload),
    )


@router.get("/{computer_id}/wol-status", response_model=WolStatusOut)
async def computer_wol_status(
    computer_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(Computer).where(Computer.id == computer_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="ПК не найден")
    return await _wol_status_for(db, c, user)


@router.put("/{computer_id}/wol-allow", response_model=WolStatusOut)
async def computer_wol_allow(
    computer_id: int,
    body: WolAllowUpdate,
    user: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(Computer).where(Computer.id == computer_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="ПК не найден")
    row = await get_wol_config_row(db)
    cfg = await get_effective_wol_config(db)
    ids = set(cfg.allowlist)
    if body.allowed:
        ids.add(int(computer_id))
    else:
        ids.discard(int(computer_id))
    row.allowlist_computer_ids_json = serialize_id_list(sorted(ids))
    db.add(
        AssetChangeLog(
            computer_id=computer_id,
            source="panel",
            kind="meta",
            field_key="wol_allowlist",
            old_value="1" if not body.allowed else "0",
            new_value="1" if body.allowed else "0",
            payload_json=json.dumps(
                {"by_user_id": user.id, "by_username": user.username, "allowed": bool(body.allowed)},
                ensure_ascii=False,
            ),
        )
    )
    await db.commit()
    return await _wol_status_for(db, c, user)


@router.post("/{computer_id}/ping", response_model=ComputerPingOut)
@limiter.limit(settings.rate_limit_ping)
async def computer_ping(
    request: Request,
    computer_id: int,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """ICMP reachability check (monitoring only). Uses last-known IP from agent."""
    _ = request
    r = await db.execute(select(Computer).where(Computer.id == computer_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="ПК не найден")
    ip = _resolve_computer_ip(c)
    if not ip:
        c.ping_status = "unknown"
        await db.commit()
        return ComputerPingOut(
            computer_id=computer_id,
            hostname=c.hostname,
            ip_address=None,
            online=None,
            checked=False,
            message=(
                "Нет IP для ping: в отчёте агента нет адреса, "
                "DNS по hostname не ответил, ARP по MAC пуст. "
                "Включите модуль «Сеть» в агенте или проверьте DNS/VLAN с сервером CORAX."
            ),
        )
    # Always refresh stored IP from latest resolved value (agent payload may have improved).
    c.ip_address = ip
    # Manual / card check: slightly longer timeout than background batches.
    online = await ping_ip(ip, timeout_ms=1500)
    c.ping_status = "online" if online else "offline"
    c.last_ping_at = datetime.now(timezone.utc)
    await db.commit()
    return ComputerPingOut(
        computer_id=computer_id,
        hostname=c.hostname,
        ip_address=ip,
        online=online,
        checked=True,
        message="В сети" if online else "Не отвечает на ping",
    )


@router.post("/{computer_id}/wake", response_model=WolWakeOut)
@limiter.limit(settings.rate_limit_wake)
async def wake_computer(
    request: Request,
    computer_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Send Wake-on-LAN for one PC.
    Superuser or user granted in Settings → WoL.
    No client-supplied MAC/IP. No bulk wake. Cannot power off.
    """
    _ = request  # required by slowapi
    r = await db.execute(select(Computer).where(Computer.id == computer_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="ПК не найден")

    cfg = await get_effective_wol_config(db)
    if cfg.force_disabled:
        raise HTTPException(status_code=403, detail="Wake-on-LAN отключён на сервере (WOL_FORCE_DISABLED)")
    if not user_may_wake(user, cfg):
        raise HTTPException(status_code=403, detail="Нет права Wake-on-LAN. Выдаёт администратор в настройках.")
    if not cfg.enabled:
        raise HTTPException(status_code=403, detail="Wake-on-LAN отключён на сервере.")

    cool = check_cooldown(computer_id, cfg.cooldown_seconds)
    if cool is not None:
        raise HTTPException(
            status_code=429,
            detail=f"Подождите {cool} с перед повторным Wake этого ПК.",
        )

    if not (c.mac_primary or "").strip():
        raise HTTPException(status_code=400, detail="У ПК нет MAC (mac_primary). Нужен отчёт агента.")
    try:
        mac = normalize_mac(c.mac_primary)
    except ValueError as e:
        raise HTTPException(status_code=400, detail="Некорректный MAC в карточке ПК.") from e

    result = send_wake(mac)
    mark_woken(computer_id)
    mac_s = format_mac(mac)
    db.add(
        AssetChangeLog(
            computer_id=computer_id,
            source="panel",
            kind="meta",
            field_key="wake",
            old_value=None,
            new_value=mac_s,
            payload_json=json.dumps(
                {
                    "by_user_id": user.id,
                    "by_username": user.username,
                    "mac": mac_s,
                    "sent": result["sent"],
                    "errors": result["errors"],
                },
                ensure_ascii=False,
            ),
        )
    )
    await db.commit()

    ok = result["sent"] > 0
    msg = (
        f"Magic packet отправлен ({result['sent']} шт.). "
        "ПК должен быть в той же L2-сети; WoL — в BIOS и NIC."
        if ok
        else "Не удалось отправить пакеты (сеть/интерфейсы сервера)."
    )
    return WolWakeOut(
        ok=ok,
        computer_id=computer_id,
        hostname=c.hostname,
        mac=mac_s,
        sent=int(result["sent"]),
        message=msg,
    )


@router.delete("/{computer_id}", status_code=204)
async def delete_computer(
    computer_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Удаляет ПК и связанные записи ПО/периферии (каскадом). Только суперпользователь."""
    r = await db.execute(select(Computer.id).where(Computer.id == computer_id))
    if r.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="ПК не найден")
    await db.execute(delete(Computer).where(Computer.id == computer_id))
    await db.commit()


@router.patch("/{computer_id}", response_model=ComputerOut)
async def update_computer(
    computer_id: int,
    body: ComputerUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(Computer).where(Computer.id == computer_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="ПК не найден")
    if body.notes is not None:
        c.notes = body.notes
    if body.location is not None:
        c.location = body.location
    if body.assigned_user_id is not None:
        if body.assigned_user_id != 0:
            ur = await db.execute(select(User).where(User.id == body.assigned_user_id))
            if not ur.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="Пользователь не найден")
            c.assigned_user_id = body.assigned_user_id
        else:
            c.assigned_user_id = None
    if body.tag_ids is not None:
        ids_ordered = list(dict.fromkeys(body.tag_ids))
        if ids_ordered:
            tr = await db.execute(select(Tag.id).where(Tag.id.in_(ids_ordered)))
            found_ids = {int(row[0]) for row in tr.all()}
            if len(found_ids) != len(ids_ordered):
                raise HTTPException(status_code=400, detail="Неизвестный тег")
        await db.execute(delete(computer_tags).where(computer_tags.c.computer_id == computer_id))
        for tid in ids_ordered:
            await db.execute(
                insert(computer_tags).values(computer_id=computer_id, tag_id=tid)
            )
    await db.commit()

    cnt_r = await db.execute(
        select(func.count()).select_from(InstalledSoftware).where(InstalledSoftware.computer_id == computer_id)
    )
    sc = int(cnt_r.scalar_one() or 0)
    cnt_pe = await db.execute(
        select(func.count()).select_from(Peripheral).where(Peripheral.computer_id == computer_id)
    )
    pc = int(cnt_pe.scalar_one() or 0)
    r_pc = await db.execute(select(Computer).where(Computer.id == computer_id))
    c2 = r_pc.scalar_one()
    tags = await _tags_for_computer(db, computer_id)
    return ComputerOut(
        id=c2.id,
        hostname=c2.hostname,
        serial_number=c2.serial_number,
        mac_primary=c2.mac_primary,
        ip_address=getattr(c2, "ip_address", None),
        ping_status=getattr(c2, "ping_status", None),
        last_ping_at=getattr(c2, "last_ping_at", None),
        cpu=c2.cpu,
        ram_gb=c2.ram_gb,
        os_name=c2.os_name,
        os_version=c2.os_version,
        manufacturer=c2.manufacturer,
        model=c2.model,
        location=c2.location,
        gpu_name=c2.gpu_name,
        memory_used_percent=c2.memory_used_percent,
        motherboard_manufacturer=c2.motherboard_manufacturer,
        motherboard_product=c2.motherboard_product,
        disks=[],
        last_report_at=c2.last_report_at,
        notes=c2.notes,
        assigned_user_id=c2.assigned_user_id,
        software_count=sc,
        peripheral_count=pc,
        tags=tags,
    )


@router.get("/{computer_id}/history")
async def computer_history(
    computer_id: int,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(100, ge=1, le=500),
):
    exists = (
        await db.execute(select(Computer.id).where(Computer.id == computer_id))
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail="ПК не найден")
    rows = (
        await db.execute(
            select(AssetChangeLog)
            .where(AssetChangeLog.computer_id == computer_id)
            .order_by(AssetChangeLog.created_at.desc(), AssetChangeLog.id.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": row.id,
            "computer_id": row.computer_id,
            "created_at": row.created_at,
            "source": row.source,
            "kind": row.kind,
            "field_key": row.field_key,
            "old_value": row.old_value,
            "new_value": row.new_value,
            "payload_json": row.payload_json,
        }
        for row in rows
    ]


@router.post("/import-glpi-pcs-csv")
async def import_glpi_pcs_csv(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
    file: UploadFile = File(...),
):
    """
    Upload GLPI PCs CSV to server filesystem as <project_root>/glpi_pcs.csv.
    Then import/update computers in DB (by hostname).
    """
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Ожидается CSV файл (.csv).")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл.")

    try:
        text = _read_text_best_effort(raw)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    reader = csv.DictReader(text.splitlines(), delimiter=";", quotechar='"')
    headers = reader.fieldnames or []
    missing = [h for h in _GLPI_PC_REQUIRED_HEADERS if h not in headers]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"CSV не похож на GLPI (ПК): нет колонок: {', '.join(missing)}",
        )

    # Aggregate by hostname/device name: keep latest 'Последнее изменение' and the most informative non-empty fields.
    agg: dict[str, dict] = {}
    rows_total = 0
    for row in reader:
        rows_total += 1
        name = (row.get("Наименование") or "").strip()
        if not name:
            continue
        key = name.strip()
        dt = _parse_glpi_pc_dt(row.get("Последнее изменение"))
        cur = agg.get(key)
        if cur is None:
            cur = {
                "name": key,
                "org": None,
                "status": None,
                "manufacturer": None,
                "model": None,
                "os": None,
                "inv": None,
                "type": None,
                "last_change": None,
                "cpu": None,
            }
            agg[key] = cur

        prev_dt = cur.get("last_change")
        if prev_dt is None or (dt is not None and prev_dt is not None and dt > prev_dt) or (dt is not None and prev_dt is None):
            cur["last_change"] = dt

        def pick(field_key: str, source_col: str):
            v = (row.get(source_col) or "").strip()
            if not v:
                return
            if cur.get(field_key) is None or cur.get(field_key) == "":
                cur[field_key] = v
            if isinstance(cur.get(field_key), str):
                low = str(cur[field_key]).strip().lower()
                if low in ("default string", "???"):
                    cur[field_key] = v

        pick("org", "Организация")
        pick("status", "Статус")
        pick("manufacturer", "Производитель")
        pick("model", "Модель")
        pick("os", "Операционная система - Наименование")
        pick("inv", "Инвентарный номер")
        pick("type", "Тип")
        pick("cpu", "Компоненты - Процессоры")

    project_root = Path(__file__).resolve().parents[3]
    dst = project_root / "glpi_pcs.csv"
    try:
        dst.write_bytes(raw)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Не удалось сохранить файл на сервере: {exc}") from exc

    created = 0
    updated = 0
    skipped = 0
    for hn, r in agg.items():
        hn_clean = (hn or "").strip()
        if not hn_clean:
            skipped += 1
            continue
        hn_key = hn_clean.lower()
        q = await db.execute(select(Computer).where(func.lower(Computer.hostname) == hn_key).limit(1))
        pc = q.scalar_one_or_none()

        inv = (r.get("inv") or "").strip() or None
        org = (r.get("org") or "").strip() or None
        status = (r.get("status") or "").strip() or None
        kind = (r.get("type") or "").strip() or None
        notes = None
        notes_bits: list[str] = []
        if org:
            notes_bits.append(f"org={org}")
        if status:
            notes_bits.append(f"status={status}")
        if kind:
            notes_bits.append(f"type={kind}")
        if inv:
            notes_bits.append(f"inv={inv}")
        if notes_bits:
            notes = "GLPI: " + "; ".join(notes_bits)

        def _dt_utc(v: datetime | None) -> datetime | None:
            if v is None:
                return None
            if v.tzinfo is None:
                return v.replace(tzinfo=timezone.utc)
            return v

        dt = _dt_utc(r.get("last_change") if isinstance(r.get("last_change"), datetime) else None)

        if pc:
            changed = False
            # Keep hostname as-is, update metadata fields.
            if inv and not pc.serial_number:
                pc.serial_number = inv[:128]
                changed = True
            if r.get("manufacturer") and pc.manufacturer != r.get("manufacturer"):
                pc.manufacturer = str(r.get("manufacturer"))[:255]
                changed = True
            if r.get("model") and pc.model != r.get("model"):
                pc.model = str(r.get("model"))[:255]
                changed = True
            if r.get("os") and pc.os_name != r.get("os"):
                pc.os_name = str(r.get("os"))[:255]
                changed = True
            if r.get("cpu") and pc.cpu != r.get("cpu"):
                pc.cpu = str(r.get("cpu"))[:512]
                changed = True
            if org and (pc.location is None or not str(pc.location).strip()):
                pc.location = org[:255]
                changed = True
            if notes and (pc.notes is None or not str(pc.notes).strip()):
                pc.notes = notes
                changed = True
            if dt is not None:
                prev = _dt_utc(pc.last_report_at)
                if prev is None or dt > prev:
                    pc.last_report_at = dt
                    changed = True
            if changed:
                updated += 1
            else:
                skipped += 1
        else:
            pc = Computer(
                hostname=hn_clean[:255],
                serial_number=(inv[:128] if inv else None),
                cpu=(str(r.get("cpu"))[:512] if r.get("cpu") else None),
                os_name=(str(r.get("os"))[:255] if r.get("os") else None),
                manufacturer=(str(r.get("manufacturer"))[:255] if r.get("manufacturer") else None),
                model=(str(r.get("model"))[:255] if r.get("model") else None),
                location=(org[:255] if org else None),
                notes=notes,
                last_report_at=(dt if isinstance(dt, datetime) else None),
            )
            db.add(pc)
            created += 1

    await db.commit()

    return {
        "filename": file.filename,
        "saved_as": str(dst.name),
        "rows_total": rows_total,
        "unique_names": len(agg),
        "created": created,
        "updated": updated,
        "skipped": skipped,
    }
