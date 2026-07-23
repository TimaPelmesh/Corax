import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.oem_normalize import (
    aggregate_manufacturer_counts,
    aggregate_system_model_counts,
    manufacturer_matches_display,
)
from app.physical_disks import (
    aggregate_physical_disks,
    disk_size_sort_key,
    disk_variant_sort_key,
    media_sort_key,
)
from app.models import DiskVolume, Peripheral, Computer, InstalledSoftware, Monitor, Printer, ServiceRequest, Tag, User
from app.dashboard_drilldown import build_segment_computer_row, fetch_segment_computers, volumes_by_computer
from app.schemas import (
    DashboardNameCount,
    DashboardPeripheralKind,
    DashboardRamBucket,
    DashboardSegmentComputer,
    DashboardSegmentComputers,
    DashboardSummary,
    DashboardDiskDeviceRank,
    SoftwareInstallHosts,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

_PERIPHERAL_KIND_LABELS: dict[str, str] = {
    "keyboard": "Клавиатуры",
    "mouse": "Мыши и указатели",
    "monitor": "Мониторы",
    "camera": "Камеры и образы (Image)",
    "audio": "Аудио",
    "printer": "Принтеры",
    "biometric": "Биометрия",
    "bluetooth": "Bluetooth",
    "touchpad": "Тачпады",
    "net": "Сетевые адаптеры",
}

_PERIPHERAL_KIND_ORDER = [
    "keyboard",
    "mouse",
    "monitor",
    "camera",
    "audio",
    "printer",
    "biometric",
    "bluetooth",
    "touchpad",
    "net",
]

_MONITOR_EXCLUDE_TOKENS = (
    "универсальный монитор pnp",
    "generic pnp monitor",
    "nvidia",
    "geforce",
    "radeon",
    "intel graphics",
    "mirror",
    "dameware",
    "remote display",
    "basic display",
)
_SERIAL_SUFFIX_RE = re.compile(r"\s+(SN|S\/N)\s*[:#]?\s*[A-Za-z0-9._\-]+.*$", re.IGNORECASE)

"""ОЗУ: группа по округлённому объёму (8 / 16 / 32 ГБ и т.д. видны отдельно)."""
_ram_gb_rounded = case(
    (Computer.ram_gb.is_(None), literal(None)),
    else_=func.round(Computer.ram_gb),
)


def _ram_bucket_sort_key(label: str) -> tuple[int, int]:
    if label == "неизвестно":
        return (-1, 0)
    if label.endswith(" ГБ"):
        try:
            return (0, int(label.replace(" ГБ", "")))
        except ValueError:
            return (1, 0)
    return (1, 0)


def _is_real_monitor_name(name: str) -> bool:
    low = name.strip().lower()
    if not low:
        return False
    return all(token not in low for token in _MONITOR_EXCLUDE_TOKENS)


def _normalize_monitor_name(name: str) -> str:
    base = _SERIAL_SUFFIX_RE.sub("", name).strip()
    return base or name.strip()


@router.get("/summary", response_model=DashboardSummary)
async def dashboard_summary(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    computers_total = int(await db.scalar(select(func.count()).select_from(Computer)) or 0)
    software_installations_total = int(
        await db.scalar(
            select(func.count())
            .select_from(InstalledSoftware)
            .join(Computer, Computer.id == InstalledSoftware.computer_id)
        )
        or 0
    )
    software_unique_titles = int(
        await db.scalar(
            select(func.count(func.distinct(InstalledSoftware.name)))
            .select_from(InstalledSoftware)
            .join(Computer, Computer.id == InstalledSoftware.computer_id)
        )
        or 0
    )
    tags_in_directory = int(await db.scalar(select(func.count()).select_from(Tag)) or 0)
    snmp_printers_total = int(
        await db.scalar(select(func.count()).select_from(Printer).where(Printer.source == "snmp"))
        or 0
    )
    service_requests_total = int(await db.scalar(select(func.count()).select_from(ServiceRequest)) or 0)
    service_requests_active = int(
        await db.scalar(
            select(func.count())
            .select_from(ServiceRequest)
            .where(ServiceRequest.status.in_(["open", "in_progress"]))
        )
        or 0
    )
    now = datetime.now(timezone.utc)
    service_requests_overdue = int(
        await db.scalar(
            select(func.count())
            .select_from(ServiceRequest)
            .where(ServiceRequest.planned_close_at.is_not(None))
            .where(ServiceRequest.planned_close_at < now)
            .where(ServiceRequest.closed_at.is_(None))
            .where(ServiceRequest.status.notin_(["done", "cancelled"]))
        )
        or 0
    )
    # Average close time: arithmetic mean of (closed_at - coalesce(opened_at, created_at))
    # only for status=done with a positive duration (bad/backdated timestamps excluded).
    _opened = func.coalesce(ServiceRequest.opened_at, ServiceRequest.created_at)
    avg_close_seconds = await db.scalar(
        select(func.avg(func.extract("epoch", ServiceRequest.closed_at - _opened)))
        .where(ServiceRequest.status == "done")
        .where(ServiceRequest.closed_at.is_not(None))
        .where(_opened.is_not(None))
        .where(ServiceRequest.closed_at > _opened)
    )
    service_requests_avg_close_hours = (
        round(float(avg_close_seconds) / 3600.0, 1) if avg_close_seconds is not None else None
    )

    async def _name_counts(q) -> list[DashboardNameCount]:
        r = await db.execute(q)
        return [DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in r.all()]

    _os_name = func.coalesce(func.nullif(func.trim(Computer.os_name), ""), "Неизвестно")
    by_os = await _name_counts(
        select(_os_name, func.count())
        .group_by(_os_name)
        .order_by(func.count().desc())
    )

    mfr_r = await db.execute(select(Computer.manufacturer, func.count()).group_by(Computer.manufacturer))
    by_manufacturer = [
        DashboardNameCount(name=n, count=c)
        for n, c in aggregate_manufacturer_counts([(row[0], int(row[1])) for row in mfr_r.all()], limit=12)
    ]

    model_r = await db.execute(select(Computer.model, func.count()).group_by(Computer.model))
    by_system_model = [
        DashboardNameCount(name=n, count=c)
        for n, c in aggregate_system_model_counts([(row[0], int(row[1])) for row in model_r.all()], limit=12)
    ]

    r = await db.execute(
        select(_ram_gb_rounded.label("gb_bucket"), func.count()).group_by(_ram_gb_rounded)
    )
    ram_buckets_raw: list[DashboardRamBucket] = []
    for row in r.all():
        gb_val, cnt = row[0], int(row[1])
        if gb_val is None:
            label = "неизвестно"
        else:
            label = f"{int(round(float(gb_val)))} ГБ"
        ram_buckets_raw.append(DashboardRamBucket(label=label, count=cnt))
    ram_buckets = sorted(ram_buckets_raw, key=lambda b: _ram_bucket_sort_key(b.label))

    top_cpu = await _name_counts(
        select(Computer.cpu, func.count())
        .where(Computer.cpu.is_not(None))
        .where(Computer.cpu != "")
        .group_by(Computer.cpu)
        .order_by(func.count().desc())
        .limit(8)
    )
    top_cpu = [DashboardNameCount(name=c.name[:120] if len(c.name) > 120 else c.name, count=c.count) for c in top_cpu]

    pc_sw = func.count(func.distinct(InstalledSoftware.computer_id))
    sw_r = await db.execute(
        select(InstalledSoftware.name, pc_sw.label("cnt"))
        .join(Computer, Computer.id == InstalledSoftware.computer_id)
        .group_by(InstalledSoftware.name)
        .order_by(pc_sw.desc())
        .limit(20)
    )
    top_software = [DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in sw_r.all()]

    pe_pc = func.count(func.distinct(Peripheral.computer_id))
    pk_r = await db.execute(
        select(Peripheral.kind, pe_pc.label("cnt"))
        .join(Computer, Computer.id == Peripheral.computer_id)
        .group_by(Peripheral.kind)
    )
    pk_rows = [
        DashboardPeripheralKind(
            kind=str(row[0]),
            label=_PERIPHERAL_KIND_LABELS.get(str(row[0]), str(row[0])),
            pc_count=int(row[1]),
        )
        for row in pk_r.all()
    ]
    peripheral_kinds = sorted(
        pk_rows,
        key=lambda x: (
            _PERIPHERAL_KIND_ORDER.index(x.kind) if x.kind in _PERIPHERAL_KIND_ORDER else 50,
            -x.pc_count,
        ),
    )

    tp_r = await db.execute(
        select(Peripheral.name, pe_pc.label("cnt"))
        .join(Computer, Computer.id == Peripheral.computer_id)
        .group_by(Peripheral.name)
        .order_by(pe_pc.desc())
        .limit(12)
    )
    top_peripherals = [
        DashboardNameCount(
            name=(n[:140] + "…") if len(n := str(row[0])) > 140 else n,
            count=int(row[1]),
        )
        for row in tp_r.all()
    ]

    status_r = await db.execute(
        select(ServiceRequest.status, func.count()).group_by(ServiceRequest.status).order_by(func.count().desc())
    )
    service_requests_by_status = [
        DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in status_r.all()
    ]

    # Monitors: merge agent PnP (peripherals.kind=monitor) and GLPI-imported monitors table.
    mon_r = await db.execute(
        select(Peripheral.name, Peripheral.computer_id)
        .join(Computer, Computer.id == Peripheral.computer_id)
        .where(Peripheral.kind == "monitor")
        .where(Peripheral.name.is_not(None))
        .where(Peripheral.name != "")
    )
    monitors_by_name: dict[str, dict[str, object]] = {}
    for row in mon_r.all():
        raw_name = str(row[0]).strip()
        pc_id = int(row[1])
        if not _is_real_monitor_name(raw_name):
            continue
        normalized = _normalize_monitor_name(raw_name)
        cur = monitors_by_name.setdefault(normalized, {"pcs": set(), "units": 0})
        (cur["pcs"]).add(pc_id)  # type: ignore[union-attr]

    glpi_r = await db.execute(
        select(Monitor.name)
        .where(Monitor.name.is_not(None))
        .where(Monitor.name != "")
    )
    for row in glpi_r.all():
        raw_name = str(row[0]).strip()
        if not raw_name:
            continue
        normalized = _normalize_monitor_name(raw_name)
        cur = monitors_by_name.setdefault(normalized, {"pcs": set(), "units": 0})
        cur["units"] = int(cur.get("units") or 0) + 1

    top_monitors = sorted(
        [
            DashboardNameCount(
                name=n,
                # Count units (GLPI) + distinct PCs (PnP). It's not perfect, but gives a useful “how common” signal.
                count=int(len(v.get("pcs") or set())) + int(v.get("units") or 0),
            )
            for n, v in monitors_by_name.items()
            if (len(v.get("pcs") or set()) + int(v.get("units") or 0)) > 0
        ],
        key=lambda x: (-x.count, x.name.lower()),
    )[:12]

    disk_r = await db.execute(
        select(
            Computer.hostname,
            func.avg(DiskVolume.used_percent).label("avg_used_percent"),
            func.count(DiskVolume.id).label("volume_count"),
        )
        .join(DiskVolume, DiskVolume.computer_id == Computer.id)
        .where(DiskVolume.mount.op("~")("^[A-Za-z]:"))
        .group_by(Computer.hostname)
        .order_by(func.avg(DiskVolume.used_percent).desc())
        .limit(10)
    )
    top_disk_devices = [
        DashboardDiskDeviceRank(
            hostname=str(row[0]),
            avg_used_percent=float(row[1] or 0.0),
            volume_count=int(row[2] or 0),
        )
        for row in disk_r.all()
    ]

    raw_r = await db.execute(select(Computer.raw_payload).where(Computer.raw_payload.is_not(None)))
    pd_total, pd_by_media, pd_by_size, pd_by_variant = aggregate_physical_disks([row[0] for row in raw_r.all()])
    physical_disks_by_media = sorted(
        [DashboardNameCount(name=n, count=c) for n, c in pd_by_media.items()],
        key=lambda x: (media_sort_key(x.name), -x.count),
    )
    physical_disks_by_size = sorted(
        [DashboardRamBucket(label=n, count=c) for n, c in pd_by_size.items()],
        key=lambda b: disk_size_sort_key(b.label),
    )
    physical_disks_by_variant = sorted(
        [DashboardNameCount(name=n, count=c) for n, c in pd_by_variant.items()],
        key=lambda x: (disk_variant_sort_key(x.name), -x.count),
    )

    # Top users by number of PCs assigned (assigned_user_id on Computer)
    _user_display = func.coalesce(func.nullif(func.trim(User.full_name), ""), User.username)
    users_r = await db.execute(
        select(
            _user_display.label("name"),
            func.count(Computer.id).label("cnt"),
        )
        .join(User, User.id == Computer.assigned_user_id)
        .group_by(_user_display)
        .order_by(func.count(Computer.id).desc())
        .limit(10)
    )
    top_users = [DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in users_r.all()]

    return DashboardSummary(
        computers_total=computers_total,
        software_installations_total=software_installations_total,
        software_unique_titles=software_unique_titles,
        tags_in_directory=tags_in_directory,
        snmp_printers_total=snmp_printers_total,
        service_requests_total=service_requests_total,
        service_requests_active=service_requests_active,
        service_requests_overdue=service_requests_overdue,
        service_requests_avg_close_hours=service_requests_avg_close_hours,
        service_requests_by_status=service_requests_by_status,
        by_os=by_os,
        by_manufacturer=by_manufacturer,
        by_system_model=by_system_model,
        ram_buckets=ram_buckets,
        top_cpu=top_cpu,
        top_software=top_software,
        top_monitors=top_monitors,
        peripheral_kinds=peripheral_kinds,
        top_peripherals=top_peripherals,
        top_disk_devices=top_disk_devices,
        physical_disks_total=pd_total,
        physical_disks_by_media=physical_disks_by_media,
        physical_disks_by_size=physical_disks_by_size,
        physical_disks_by_variant=physical_disks_by_variant,
        top_users=top_users,
    )


_SEGMENT_KINDS = (
    "os|manufacturer|system_model|ram|cpu|monitor|physical_disk|software|peripheral|peripheral_kind|hostname"
)


@router.get("/segment-computers", response_model=DashboardSegmentComputers)
async def segment_computers(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    kind: str = Query(..., pattern=f"^({_SEGMENT_KINDS})$"),
    name: str = Query(..., min_length=1, max_length=512),
    chart_title: str | None = Query(None, max_length=255),
    limit: int = Query(200, ge=1, le=500),
):
    computers, total = await fetch_segment_computers(db, kind=kind, name=name.strip(), limit=limit)
    vols = await volumes_by_computer(db, [c.id for c in computers])
    items = [
        DashboardSegmentComputer(**build_segment_computer_row(c, vols.get(c.id, [])))
        for c in computers
    ]
    return DashboardSegmentComputers(
        kind=kind,
        name=name.strip(),
        chart_title=chart_title,
        total=total,
        items=items,
    )


@router.get("/software-catalog", response_model=list[DashboardNameCount])
async def software_catalog(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    q: str | None = Query(None, description="Поиск по названию"),
    limit: int = Query(400, ge=1, le=2000),
):
    """Сводка ПО: сколько ПК с каждым названием (для каталога с поиском)."""
    cnt = func.count(func.distinct(InstalledSoftware.computer_id)).label("pc_cnt")
    stmt = (
        select(InstalledSoftware.name, cnt)
        .join(Computer, Computer.id == InstalledSoftware.computer_id)
        .group_by(InstalledSoftware.name)
    )
    if q and q.strip():
        stmt = stmt.where(InstalledSoftware.name.ilike(f"%{q.strip()}%"))
    stmt = stmt.order_by(cnt.desc()).limit(limit)
    r = await db.execute(stmt)
    return [DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in r.all()]


@router.get("/software-hosts", response_model=SoftwareInstallHosts)
async def software_hosts(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    name: str = Query(..., min_length=1, max_length=512),
):
    """Список имён ПК, где есть запись ПО с указанным точным названием."""
    r = await db.execute(
        select(Computer.hostname)
        .join(InstalledSoftware, InstalledSoftware.computer_id == Computer.id)
        .where(InstalledSoftware.name == name)
        .distinct()
        .order_by(Computer.hostname.asc())
    )
    hostnames = [str(row[0]) for row in r.all()]
    return SoftwareInstallHosts(name=name, hostnames=hostnames)


@router.get("/catalog", response_model=list[DashboardNameCount])
async def unified_catalog(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    kind: str = Query("software", pattern="^(software|peripheral|cpu|os|manufacturer)$"),
    q: str | None = Query(None),
    limit: int = Query(400, ge=1, le=2000),
):
    qv = (q or "").strip()
    if kind == "software":
        cnt = func.count(func.distinct(InstalledSoftware.computer_id)).label("pc_cnt")
        stmt = (
            select(InstalledSoftware.name, cnt)
            .join(Computer, Computer.id == InstalledSoftware.computer_id)
            .group_by(InstalledSoftware.name)
        )
        if qv:
            stmt = stmt.where(InstalledSoftware.name.ilike(f"%{qv}%"))
        stmt = stmt.order_by(cnt.desc()).limit(limit)
    elif kind == "peripheral":
        cnt = func.count(func.distinct(Peripheral.computer_id)).label("pc_cnt")
        stmt = (
            select(Peripheral.name, cnt)
            .join(Computer, Computer.id == Peripheral.computer_id)
            .group_by(Peripheral.name)
        )
        if qv:
            stmt = stmt.where(Peripheral.name.ilike(f"%{qv}%"))
        stmt = stmt.order_by(cnt.desc()).limit(limit)
    elif kind == "cpu":
        cnt = func.count().label("pc_cnt")
        stmt = (
            select(Computer.cpu, cnt)
            .where(Computer.cpu.is_not(None))
            .where(Computer.cpu != "")
            .group_by(Computer.cpu)
        )
        if qv:
            stmt = stmt.where(Computer.cpu.ilike(f"%{qv}%"))
        stmt = stmt.order_by(cnt.desc()).limit(limit)
    elif kind == "os":
        os_name = func.coalesce(func.nullif(func.trim(Computer.os_name), ""), "Неизвестно")
        cnt = func.count().label("pc_cnt")
        stmt = select(os_name, cnt).group_by(os_name)
        if qv:
            stmt = stmt.where(os_name.ilike(f"%{qv}%"))
        stmt = stmt.order_by(cnt.desc()).limit(limit)
    else:
        mfr_r = await db.execute(select(Computer.manufacturer, func.count()).group_by(Computer.manufacturer))
        merged = aggregate_manufacturer_counts([(row[0], int(row[1])) for row in mfr_r.all()])
        if qv:
            qlow = qv.lower()
            merged = [(n, c) for n, c in merged if qlow in n.lower()]
        return [DashboardNameCount(name=n, count=c) for n, c in merged[:limit]]
    r = await db.execute(stmt)
    return [DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in r.all()]


@router.get("/catalog-hosts", response_model=SoftwareInstallHosts)
async def unified_catalog_hosts(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    kind: str = Query(..., pattern="^(software|peripheral|cpu|os|manufacturer)$"),
    name: str = Query(..., min_length=1, max_length=512),
):
    if kind == "software":
        stmt = (
            select(Computer.hostname)
            .join(InstalledSoftware, InstalledSoftware.computer_id == Computer.id)
            .where(InstalledSoftware.name == name)
            .distinct()
            .order_by(Computer.hostname.asc())
        )
    elif kind == "peripheral":
        stmt = (
            select(Computer.hostname)
            .join(Peripheral, Peripheral.computer_id == Computer.id)
            .where(Peripheral.name == name)
            .distinct()
            .order_by(Computer.hostname.asc())
        )
    elif kind == "cpu":
        stmt = (
            select(Computer.hostname)
            .where(Computer.cpu == name)
            .distinct()
            .order_by(Computer.hostname.asc())
        )
    elif kind == "os":
        os_name = func.coalesce(func.nullif(func.trim(Computer.os_name), ""), "Неизвестно")
        stmt = (
            select(Computer.hostname)
            .where(os_name == name)
            .distinct()
            .order_by(Computer.hostname.asc())
        )
    else:
        mfr_r = await db.execute(select(Computer.hostname, Computer.manufacturer).order_by(Computer.hostname.asc()))
        hostnames = [
            str(row[0])
            for row in mfr_r.all()
            if manufacturer_matches_display(row[1], name)
        ]
        return SoftwareInstallHosts(name=name, hostnames=hostnames)
    r = await db.execute(stmt)
    hostnames = [str(row[0]) for row in r.all()]
    return SoftwareInstallHosts(name=name, hostnames=hostnames)
