import asyncio
import logging
import re
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, cast, Date, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession
from app.auth import get_current_user
from app.database import AsyncSessionLocal, get_db
from app.oem_normalize import (
    aggregate_manufacturer_counts,
    aggregate_motherboard_counts,
    aggregate_system_model_counts,
)
from app.os_normalize import aggregate_os_counts
from app.software_families import classify_software_name
from app.physical_disks import (
    aggregate_physical_disks,
    aggregate_pc_disk_catalog,
    disk_size_sort_key,
    disk_variant_sort_key,
    media_sort_key,
)
from app.models import (
    Computer,
    DiskVolume,
    InstalledSoftware,
    Monitor,
    Note,
    NoteShare,
    Peripheral,
    Printer,
    ServiceRequest,
    Tag,
    User,
)
from app.dashboard_drilldown import (
    build_segment_computer_row,
    fetch_computers_matching_filters,
    fetch_segment_computers,
    volumes_by_computer,
)
from app.printer_cleanup import is_noise_printer_row
from app.routers.notes import accessible_notes_count, accessible_upcoming_notes
from app.text_sanitize import like_contains
from app.schemas import (
    CatalogFilterHostsRequest,
    CatalogFilterHostsResponse,
    CatalogFilterItem,
    DashboardNameCount,
    DashboardPeripheralKind,
    DashboardRamBucket,
    DashboardSegmentComputer,
    DashboardSegmentComputers,
    DashboardNavBadges,
    DashboardSummary,
    DashboardCalendarItem,
    DashboardDiskDeviceRank,
    DashboardTimePoint,
    DashboardUpcomingNote,
    SoftwareInstallHosts,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _count_tab_printers(rows: list[tuple]) -> int:
    return sum(1 for n, m, sn in rows if not is_noise_printer_row(n, m, sn))


logger = logging.getLogger(__name__)

_SUMMARY_CACHE_SECONDS = 45.0
_SUMMARY_CACHE: tuple[float, tuple, DashboardSummary] | None = None
# Thundering-herd guard: если 10 клиентов пришли одновременно на холодный
# кэш, считать дашборд должен один — остальные подождут единицы миллисекунд
# и получат уже готовый результат из кэша.
_SUMMARY_COMPUTE_LOCK = asyncio.Lock()

# Sidebar polls nav-badges on nearly every route change; four SELECTs each
# time on a busy panel is wasteful. 5-second per-user memo is invisible to
# the user (counter can lag by a few seconds) and still respects tenancy —
# `notes_total` depends on the caller.
_NAV_BADGES_CACHE_SECONDS = 5.0
_NAV_BADGES_CACHE: dict[int, tuple[float, DashboardNavBadges]] = {}


def _nav_badges_cache_get(user_id: int, now_mono: float) -> DashboardNavBadges | None:
    entry = _NAV_BADGES_CACHE.get(user_id)
    if entry and entry[0] > now_mono:
        return entry[1]
    return None


def _nav_badges_cache_put(user_id: int, now_mono: float, value: DashboardNavBadges) -> None:
    _NAV_BADGES_CACHE[user_id] = (now_mono + _NAV_BADGES_CACHE_SECONDS, value)
    # Prevent unbounded growth on churny sessions (LDAP mass sync, tests).
    if len(_NAV_BADGES_CACHE) > 512:
        cutoff = now_mono
        stale = [uid for uid, (exp, _v) in _NAV_BADGES_CACHE.items() if exp <= cutoff]
        for uid in stale:
            _NAV_BADGES_CACHE.pop(uid, None)

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


def _as_utc_date(value: datetime) -> date:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).date()


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _next_month(d: date) -> date:
    if d.month == 12:
        return date(d.year + 1, 1, 1)
    return date(d.year, d.month + 1, 1)


def build_closed_tickets_series(closed_at_values: list[datetime]) -> tuple[str, list[DashboardTimePoint]]:
    """Bucket closed tickets into day/week/month series spanning the full history."""
    if not closed_at_values:
        return "day", []
    return build_closed_tickets_series_from_day_counts(
        Counter(_as_utc_date(v) for v in closed_at_values)
    )


def build_closed_tickets_series_from_day_counts(
    day_counts: Counter[date],
) -> tuple[str, list[DashboardTimePoint]]:
    if not day_counts:
        return "day", []

    days = sorted(day_counts.keys())
    first, last = days[0], days[-1]
    span = (last - first).days

    if span <= 56:
        granularity = "day"

        def bucket(d: date) -> date:
            return d

        def advance(d: date) -> date:
            return d + timedelta(days=1)
    elif span <= 420:
        granularity = "week"

        def bucket(d: date) -> date:
            return d - timedelta(days=d.weekday())

        def advance(d: date) -> date:
            return d + timedelta(days=7)
    else:
        granularity = "month"

        def bucket(d: date) -> date:
            return _month_start(d)

        def advance(d: date) -> date:
            return _next_month(d)

    counts: Counter[date] = Counter()
    for day, n in day_counts.items():
        counts[bucket(day)] += int(n)

    cur = bucket(first)
    end = bucket(last)
    points: list[DashboardTimePoint] = []
    cumulative = 0
    while cur <= end:
        c = int(counts.get(cur, 0))
        cumulative += c
        points.append(DashboardTimePoint(date=cur.isoformat(), count=c, cumulative=cumulative))
        cur = advance(cur)

    return granularity, points


async def _with_fresh_session(fn):
    """Run a coroutine with its own AsyncSession — safe for asyncio.gather."""
    async with AsyncSessionLocal() as session:
        return await fn(session)


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


async def _dashboard_stamp(db: AsyncSession) -> tuple:
    computer_n, last_report, last_ping, ticket_n, ticket_updated = (
        await db.execute(
            select(
                select(func.count()).select_from(Computer).scalar_subquery(),
                select(func.max(Computer.last_report_at)).scalar_subquery(),
                select(func.max(Computer.last_ping_at)).scalar_subquery(),
                select(func.count()).select_from(ServiceRequest).scalar_subquery(),
                select(func.max(ServiceRequest.updated_at)).scalar_subquery(),
            )
        )
    ).one()
    return (
        int(computer_n or 0),
        str(last_report),
        str(last_ping),
        int(ticket_n or 0),
        str(ticket_updated),
    )


@router.get("/calendar", response_model=list[DashboardCalendarItem])
async def dashboard_calendar(
    month: date = Query(..., description="Any date in the requested month"),
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Visible plans and open tickets with a planned close date for one month."""
    month_start = _month_start(month)
    next_month = _next_month(month_start)

    if current.is_superuser:
        notes_access = True
    else:
        shared_note_ids = select(NoteShare.note_id).where(NoteShare.user_id == current.id)
        notes_access = (Note.owner_user_id == current.id) | Note.id.in_(shared_note_ids)

    plans_query = select(Note).where(
        (Note.plan_start.is_not(None)) | (Note.plan_end.is_not(None)),
        (Note.plan_start.is_(None)) | (Note.plan_start < next_month),
        (Note.plan_end.is_(None)) | (Note.plan_end >= month_start),
    )
    if notes_access is not True:
        plans_query = plans_query.where(notes_access)
    plans_stmt = plans_query.order_by(Note.plan_start.asc().nulls_last(), Note.id.asc()).limit(500)

    window_start = datetime.combine(month_start, datetime.min.time(), tzinfo=timezone.utc)
    window_end = datetime.combine(next_month, datetime.min.time(), tzinfo=timezone.utc)
    requests_stmt = (
        select(ServiceRequest)
        .where(
            ServiceRequest.status == "open",
            ServiceRequest.planned_close_at.is_not(None),
            ServiceRequest.planned_close_at >= window_start,
            ServiceRequest.planned_close_at < window_end,
        )
        .order_by(ServiceRequest.planned_close_at.asc(), ServiceRequest.id.asc())
        .limit(500)
    )

    async def _plans(s: AsyncSession):
        return list((await s.execute(plans_stmt)).scalars().all())

    async def _requests(s: AsyncSession):
        return list((await s.execute(requests_stmt)).scalars().all())

    plans, requests = await asyncio.gather(_with_fresh_session(_plans), _with_fresh_session(_requests))
    del db  # request session unused after parallel reads

    items = [
        DashboardCalendarItem(
            id=note.id,
            kind="plan",
            title=note.title or "—",
            start_date=max(note.plan_start or note.plan_end, month_start),
            end_date=min(note.plan_end or note.plan_start, next_month - timedelta(days=1)),
            color=note.color,  # type: ignore[arg-type]
            mark=note.mark,  # type: ignore[arg-type]
        )
        for note in plans
    ]
    items.extend(
        DashboardCalendarItem(
            id=request.id,
            kind="request",
            title=request.title,
            start_date=request.planned_close_at.date(),
        )
        for request in requests
        if request.planned_close_at is not None
    )
    return items


@router.get("/nav-badges", response_model=DashboardNavBadges)
async def dashboard_nav_badges(
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Counts for sidebar badges only — avoids the full dashboard/summary payload."""
    now_mono = time.monotonic()
    cached = _nav_badges_cache_get(current.id, now_mono)
    if cached is not None:
        return cached

    async def _computers(s: AsyncSession) -> int:
        return int(await s.scalar(select(func.count()).select_from(Computer)) or 0)

    async def _software(s: AsyncSession) -> int:
        return int(
            await s.scalar(
                select(func.count(func.distinct(InstalledSoftware.name)))
                .select_from(InstalledSoftware)
                .join(Computer, Computer.id == InstalledSoftware.computer_id)
            )
            or 0
        )

    async def _printers(s: AsyncSession) -> int:
        rows = (
            await s.execute(
                select(Printer.name, Printer.snmp_model, Printer.snmp_sys_name).where(
                    Printer.source.in_(("snmp", "manual"))
                )
            )
        ).all()
        return _count_tab_printers(rows)

    async def _active_requests(s: AsyncSession) -> int:
        return int(
            await s.scalar(
                select(func.count())
                .select_from(ServiceRequest)
                .where(ServiceRequest.status.in_(["open", "in_progress"]))
            )
            or 0
        )

    async def _notes(s: AsyncSession) -> int:
        return await accessible_notes_count(s, current)

    (
        computers_total,
        software_unique_titles,
        snmp_printers_total,
        service_requests_active,
        notes_total,
    ) = await asyncio.gather(
        _with_fresh_session(_computers),
        _with_fresh_session(_software),
        _with_fresh_session(_printers),
        _with_fresh_session(_active_requests),
        _with_fresh_session(_notes),
    )
    del db
    result = DashboardNavBadges(
        computers_total=computers_total,
        software_unique_titles=software_unique_titles,
        service_requests_active=service_requests_active,
        snmp_printers_total=snmp_printers_total,
        notes_total=notes_total,
    )
    _nav_badges_cache_put(current.id, now_mono, result)
    return result


@router.get("/summary", response_model=DashboardSummary)
async def dashboard_summary(
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    global _SUMMARY_CACHE
    now_mono = time.monotonic()
    stamp = await _dashboard_stamp(db)
    cached = _SUMMARY_CACHE
    if cached and cached[0] > now_mono and cached[1] == stamp:
        inventory = cached[2]
    else:
        async with _SUMMARY_COMPUTE_LOCK:
            # Re-check under the lock: пока ждали — соседний запрос мог уже посчитать.
            cached = _SUMMARY_CACHE
            now_mono = time.monotonic()
            if cached and cached[0] > now_mono and cached[1] == stamp:
                inventory = cached[2]
            else:
                inventory = await _compute_dashboard_inventory(db)
                _SUMMARY_CACHE = (now_mono + _SUMMARY_CACHE_SECONDS, stamp, inventory)

    async def _upcoming(s: AsyncSession):
        return await accessible_upcoming_notes(s, current, horizon_days=30, limit=8)

    async def _notes_count(s: AsyncSession):
        return await accessible_notes_count(s, current)

    upcoming_raw, notes_total = await asyncio.gather(
        _with_fresh_session(_upcoming),
        _with_fresh_session(_notes_count),
    )
    upcoming_notes = [
        DashboardUpcomingNote(
            id=n.id,
            title=n.title or "",
            plan_start=n.plan_start,
            plan_end=n.plan_end,
            owner_username=owner.username if owner else None,
        )
        for n, owner in upcoming_raw
    ]
    return inventory.model_copy(update={"upcoming_notes": upcoming_notes, "notes_total": notes_total})


async def _compute_dashboard_inventory(db: AsyncSession) -> DashboardSummary:
    """Inventory analytics. Independent SELECTs run in parallel on fresh sessions."""
    del db  # request session is not concurrency-safe; each worker opens its own
    ping_status_l = func.lower(func.coalesce(Computer.ping_status, ""))
    pe_pc = func.count(func.distinct(Peripheral.computer_id))
    pc_sw = func.count(func.distinct(InstalledSoftware.computer_id))

    async def _fleet() -> tuple[int, int, int, int]:
        async with AsyncSessionLocal() as s:
            row = (
                await s.execute(
                    select(
                        func.count().label("total"),
                        func.coalesce(func.sum(case((ping_status_l == "online", 1), else_=0)), 0).label(
                            "online"
                        ),
                        func.coalesce(func.sum(case((ping_status_l == "offline", 1), else_=0)), 0).label(
                            "offline"
                        ),
                    )
                )
            ).one()
            total = int(row.total or 0)
            online = int(row.online or 0)
            offline = int(row.offline or 0)
            return total, online, offline, max(0, total - online - offline)

    async def _software_totals() -> tuple[int, int]:
        async with AsyncSessionLocal() as s:
            row = (
                await s.execute(
                    select(
                        func.count().label("installs"),
                        func.count(func.distinct(InstalledSoftware.name)).label("titles"),
                    )
                    .select_from(InstalledSoftware)
                    .join(Computer, Computer.id == InstalledSoftware.computer_id)
                )
            ).one()
            return int(row.installs or 0), int(row.titles or 0)

    async def _tags() -> int:
        async with AsyncSessionLocal() as s:
            return int(await s.scalar(select(func.count()).select_from(Tag)) or 0)

    async def _printers() -> int:
        async with AsyncSessionLocal() as s:
            rows = (
                await s.execute(
                    select(Printer.name, Printer.snmp_model, Printer.snmp_sys_name).where(
                        Printer.source.in_(("snmp", "manual"))
                    )
                )
            ).all()
            return _count_tab_printers(rows)

    async def _service_block() -> tuple[
        list[DashboardNameCount],
        int,
        int,
        int,
        int | None,
        float | None,
        str,
        list[DashboardTimePoint],
    ]:
        async with AsyncSessionLocal() as s:
            status_r = await s.execute(
                select(ServiceRequest.status, func.count())
                .group_by(ServiceRequest.status)
                .order_by(func.count().desc())
            )
            by_status = [
                DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in status_r.all()
            ]
            status_map = {item.name: item.count for item in by_status}
            total = sum(status_map.values())
            active = int(status_map.get("open", 0) + status_map.get("in_progress", 0))
            now = datetime.now(timezone.utc)
            overdue = int(
                await s.scalar(
                    select(func.count())
                    .select_from(ServiceRequest)
                    .where(ServiceRequest.planned_close_at.is_not(None))
                    .where(ServiceRequest.planned_close_at < now)
                    .where(ServiceRequest.closed_at.is_(None))
                    .where(ServiceRequest.status.notin_(["done", "cancelled"]))
                )
                or 0
            )
            plan_row = (
                await s.execute(
                    select(
                        func.count().label("with_plan"),
                        func.coalesce(
                            func.sum(
                                case(
                                    (ServiceRequest.closed_at <= ServiceRequest.planned_close_at, 1),
                                    else_=0,
                                )
                            ),
                            0,
                        ).label("on_time"),
                    )
                    .where(ServiceRequest.closed_at.is_not(None))
                    .where(ServiceRequest.planned_close_at.is_not(None))
                )
            ).one()
            closed_with_plan = int(plan_row.with_plan or 0)
            on_time_pct = (
                int(round((int(plan_row.on_time or 0) / closed_with_plan) * 100))
                if closed_with_plan > 0
                else None
            )
            _opened = func.coalesce(ServiceRequest.opened_at, ServiceRequest.created_at)
            avg_close_seconds = await s.scalar(
                select(func.avg(func.extract("epoch", ServiceRequest.closed_at - _opened)))
                .where(ServiceRequest.status == "done")
                .where(ServiceRequest.closed_at.is_not(None))
                .where(_opened.is_not(None))
                .where(ServiceRequest.closed_at > _opened)
            )
            avg_hours = (
                round(float(avg_close_seconds) / 3600.0, 1) if avg_close_seconds is not None else None
            )
            # Same UTC day buckets as build_closed_tickets_series(_as_utc_date(...)).
            day_expr = cast(func.timezone("UTC", ServiceRequest.closed_at), Date)
            day_rows = (
                await s.execute(
                    select(day_expr, func.count())
                    .where(ServiceRequest.closed_at.is_not(None))
                    .group_by(day_expr)
                )
            ).all()
            day_counts: Counter[date] = Counter()
            for d, c in day_rows:
                if d is None:
                    continue
                if isinstance(d, datetime):
                    d = d.date()
                day_counts[d] += int(c or 0)
            granularity, series = build_closed_tickets_series_from_day_counts(day_counts)
            return by_status, total, active, overdue, on_time_pct, avg_hours, granularity, series

    async def _computer_dists() -> tuple[
        list[DashboardNameCount],
        list[DashboardNameCount],
        list[DashboardNameCount],
        list[DashboardRamBucket],
        list[DashboardNameCount],
    ]:
        async with AsyncSessionLocal() as s:
            _os_r = await s.execute(select(Computer.os_name, func.count()).group_by(Computer.os_name))
            by_os = [
                DashboardNameCount(name=n, count=c)
                for n, c in aggregate_os_counts([(row[0], int(row[1])) for row in _os_r.all()])
            ]
            mfr_r = await s.execute(
                select(Computer.manufacturer, func.count()).group_by(Computer.manufacturer)
            )
            by_manufacturer = [
                DashboardNameCount(name=n, count=c)
                for n, c in aggregate_manufacturer_counts(
                    [(row[0], int(row[1])) for row in mfr_r.all()], limit=12
                )
            ]
            model_r = await s.execute(select(Computer.model, func.count()).group_by(Computer.model))
            by_system_model = [
                DashboardNameCount(name=n, count=c)
                for n, c in aggregate_system_model_counts(
                    [(row[0], int(row[1])) for row in model_r.all()], limit=12
                )
            ]
            r = await s.execute(
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
            cpu_r = await s.execute(
                select(Computer.cpu, func.count())
                .where(Computer.cpu.is_not(None))
                .where(Computer.cpu != "")
                .group_by(Computer.cpu)
                .order_by(func.count().desc())
                .limit(8)
            )
            top_cpu = [
                DashboardNameCount(
                    name=(n := str(row[0]))[:120] if len(str(row[0])) > 120 else str(row[0]),
                    count=int(row[1]),
                )
                for row in cpu_r.all()
            ]
            return by_os, by_manufacturer, by_system_model, ram_buckets, top_cpu

    async def _top_software() -> list[DashboardNameCount]:
        async with AsyncSessionLocal() as s:
            sw_r = await s.execute(
                select(InstalledSoftware.name, pc_sw.label("cnt"))
                .join(Computer, Computer.id == InstalledSoftware.computer_id)
                .group_by(InstalledSoftware.name)
                .order_by(pc_sw.desc())
                .limit(10)
            )
            return [DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in sw_r.all()]

    async def _software_families() -> tuple[list[DashboardNameCount], list[DashboardNameCount]]:
        """Same classify_software_name quality; one row per title via array_agg(distinct pc)."""
        async with AsyncSessionLocal() as s:
            fam_r = await s.execute(
                select(
                    InstalledSoftware.name,
                    func.array_agg(func.distinct(InstalledSoftware.computer_id)),
                )
                .join(Computer, Computer.id == InstalledSoftware.computer_id)
                .group_by(InstalledSoftware.name)
            )
            browsers_ids: dict[str, set[int]] = {}
            office_ids: dict[str, set[int]] = {}
            for sw_name, pc_ids in fam_r.all():
                fam = classify_software_name(str(sw_name))
                if fam is None:
                    continue
                bucket = browsers_ids if fam.category == "browser" else office_ids
                dest = bucket.setdefault(fam.name, set())
                for cid in pc_ids or []:
                    if cid is not None:
                        dest.add(int(cid))
            browsers = [
                DashboardNameCount(name=n, count=len(ids))
                for n, ids in sorted(browsers_ids.items(), key=lambda kv: (-len(kv[1]), kv[0]))
            ]
            office_suites = [
                DashboardNameCount(name=n, count=len(ids))
                for n, ids in sorted(office_ids.items(), key=lambda kv: (-len(kv[1]), kv[0]))
            ]
            return browsers, office_suites

    async def _peripherals() -> tuple[list[DashboardPeripheralKind], list[DashboardNameCount]]:
        async with AsyncSessionLocal() as s:
            pk_r = await s.execute(
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
            tp_r = await s.execute(
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
            return peripheral_kinds, top_peripherals

    async def _monitors() -> list[DashboardNameCount]:
        async with AsyncSessionLocal() as s:
            mon_r = await s.execute(
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

            glpi_r = await s.execute(
                select(Monitor.name).where(Monitor.name.is_not(None)).where(Monitor.name != "")
            )
            for row in glpi_r.all():
                raw_name = str(row[0]).strip()
                if not raw_name:
                    continue
                normalized = _normalize_monitor_name(raw_name)
                cur = monitors_by_name.setdefault(normalized, {"pcs": set(), "units": 0})
                cur["units"] = int(cur.get("units") or 0) + 1

        return sorted(
            [
                DashboardNameCount(
                    name=n,
                    count=int(len(v.get("pcs") or set())) + int(v.get("units") or 0),
                )
                for n, v in monitors_by_name.items()
                if (len(v.get("pcs") or set()) + int(v.get("units") or 0)) > 0
            ],
            key=lambda x: (-x.count, x.name.lower()),
        )[:12]

    async def _disk_devices() -> list[DashboardDiskDeviceRank]:
        async with AsyncSessionLocal() as s:
            disk_r = await s.execute(
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
            return [
                DashboardDiskDeviceRank(
                    hostname=str(row[0]),
                    avg_used_percent=float(row[1] or 0.0),
                    volume_count=int(row[2] or 0),
                )
                for row in disk_r.all()
            ]

    async def _physical_disks() -> tuple[
        int, list[DashboardNameCount], list[DashboardRamBucket], list[DashboardNameCount]
    ]:
        async with AsyncSessionLocal() as s:
            raw_r = await s.execute(select(Computer.raw_payload).where(Computer.raw_payload.is_not(None)))
            pd_total, pd_by_media, pd_by_size, pd_by_variant = aggregate_physical_disks(
                [row[0] for row in raw_r.all()]
            )
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
        return pd_total, physical_disks_by_media, physical_disks_by_size, physical_disks_by_variant

    (
        (computers_total, computers_online, computers_offline, computers_unknown),
        (software_installations_total, software_unique_titles),
        tags_in_directory,
        snmp_printers_total,
        (
            service_requests_by_status,
            service_requests_total,
            service_requests_active,
            service_requests_overdue,
            service_requests_on_time_pct,
            service_requests_avg_close_hours,
            closed_granularity,
            closed_series,
        ),
        (by_os, by_manufacturer, by_system_model, ram_buckets, top_cpu),
        top_software,
        (browsers, office_suites),
        (peripheral_kinds, top_peripherals),
        top_monitors,
        top_disk_devices,
        (pd_total, physical_disks_by_media, physical_disks_by_size, physical_disks_by_variant),
    ) = await asyncio.gather(
        _fleet(),
        _software_totals(),
        _tags(),
        _printers(),
        _service_block(),
        _computer_dists(),
        _top_software(),
        _software_families(),
        _peripherals(),
        _monitors(),
        _disk_devices(),
        _physical_disks(),
    )

    return DashboardSummary(
        computers_total=computers_total,
        computers_online=computers_online,
        computers_offline=computers_offline,
        computers_unknown=computers_unknown,
        software_installations_total=software_installations_total,
        software_unique_titles=software_unique_titles,
        tags_in_directory=tags_in_directory,
        snmp_printers_total=snmp_printers_total,
        service_requests_total=service_requests_total,
        service_requests_active=service_requests_active,
        service_requests_overdue=service_requests_overdue,
        service_requests_on_time_pct=service_requests_on_time_pct,
        service_requests_avg_close_hours=service_requests_avg_close_hours,
        service_requests_by_status=service_requests_by_status,
        service_requests_closed_granularity=closed_granularity,
        service_requests_closed_series=closed_series,
        by_os=by_os,
        by_manufacturer=by_manufacturer,
        by_system_model=by_system_model,
        ram_buckets=ram_buckets,
        top_cpu=top_cpu,
        top_software=top_software,
        browsers=browsers,
        office_suites=office_suites,
        top_monitors=top_monitors,
        peripheral_kinds=peripheral_kinds,
        top_peripherals=top_peripherals,
        top_disk_devices=top_disk_devices,
        physical_disks_total=pd_total,
        physical_disks_by_media=physical_disks_by_media,
        physical_disks_by_size=physical_disks_by_size,
        physical_disks_by_variant=physical_disks_by_variant,
        upcoming_notes=[],
        notes_total=0,
    )


_SEGMENT_KINDS = (
    "os|manufacturer|system_model|motherboard|ram|cpu|monitor|physical_disk|software|software_family|peripheral|peripheral_kind|hostname"
)
_CATALOG_KINDS = (
    "software|peripheral|cpu|os|manufacturer|system_model|motherboard|ram|physical_disk"
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
    vols: dict[int, list] = {}
    assignee_map: dict[int, str] = {}
    try:
        vols = await volumes_by_computer(db, [c.id for c in computers])
        assignee_map = await _assignee_names_for_computers(db, computers)
    except Exception:
        logger.exception("dashboard segment extras failed kind=%s — returning host list without extras", kind)
    items: list[DashboardSegmentComputer] = []
    for c in computers:
        try:
            items.append(
                DashboardSegmentComputer(
                    **build_segment_computer_row(
                        c,
                        vols.get(c.id, []),
                        assigned_user_name=assignee_map.get(c.id),
                    )
                )
            )
        except Exception:
            logger.exception("dashboard segment row failed computer_id=%s kind=%s", getattr(c, "id", None), kind)
            items.append(
                DashboardSegmentComputer(
                    id=int(c.id),
                    hostname=(c.hostname or "").strip() or f"#{c.id}",
                )
            )
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
        stmt = stmt.where(InstalledSoftware.name.ilike(like_contains(q), escape="\\"))
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
    kind: str = Query("software", pattern=f"^({_CATALOG_KINDS})$"),
    q: str | None = Query(None),
    limit: int = Query(2000, ge=1, le=5000),
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
            stmt = stmt.where(InstalledSoftware.name.ilike(like_contains(qv), escape="\\"))
        stmt = stmt.order_by(cnt.desc()).limit(limit)
        r = await db.execute(stmt)
        return [DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in r.all()]

    if kind == "peripheral":
        cnt = func.count(func.distinct(Peripheral.computer_id)).label("pc_cnt")
        stmt = (
            select(Peripheral.name, cnt)
            .join(Computer, Computer.id == Peripheral.computer_id)
            .group_by(Peripheral.name)
        )
        if qv:
            stmt = stmt.where(Peripheral.name.ilike(like_contains(qv), escape="\\"))
        stmt = stmt.order_by(cnt.desc()).limit(limit)
        r = await db.execute(stmt)
        return [DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in r.all()]

    if kind == "cpu":
        cnt = func.count().label("pc_cnt")
        stmt = (
            select(Computer.cpu, cnt)
            .where(Computer.cpu.is_not(None))
            .where(Computer.cpu != "")
            .group_by(Computer.cpu)
        )
        if qv:
            stmt = stmt.where(Computer.cpu.ilike(like_contains(qv), escape="\\"))
        stmt = stmt.order_by(cnt.desc()).limit(limit)
        r = await db.execute(stmt)
        return [DashboardNameCount(name=str(row[0]), count=int(row[1])) for row in r.all()]

    if kind == "os":
        os_r = await db.execute(select(Computer.os_name, func.count()).group_by(Computer.os_name))
        merged = aggregate_os_counts([(row[0], int(row[1])) for row in os_r.all()])
        if qv:
            qlow = qv.lower()
            merged = [(n, c) for n, c in merged if qlow in n.lower()]
        return [DashboardNameCount(name=n, count=c) for n, c in merged[:limit]]

    if kind == "manufacturer":
        mfr_r = await db.execute(select(Computer.manufacturer, func.count()).group_by(Computer.manufacturer))
        merged = aggregate_manufacturer_counts([(row[0], int(row[1])) for row in mfr_r.all()])
        if qv:
            qlow = qv.lower()
            merged = [(n, c) for n, c in merged if qlow in n.lower()]
        return [DashboardNameCount(name=n, count=c) for n, c in merged[:limit]]

    if kind == "system_model":
        model_r = await db.execute(select(Computer.model, func.count()).group_by(Computer.model))
        merged = aggregate_system_model_counts([(row[0], int(row[1])) for row in model_r.all()])
        if qv:
            qlow = qv.lower()
            merged = [(n, c) for n, c in merged if qlow in n.lower()]
        return [DashboardNameCount(name=n, count=c) for n, c in merged[:limit]]

    if kind == "motherboard":
        mb_r = await db.execute(
            select(
                Computer.motherboard_manufacturer,
                Computer.motherboard_product,
                func.count(),
            ).group_by(Computer.motherboard_manufacturer, Computer.motherboard_product)
        )
        merged = aggregate_motherboard_counts(
            [(row[0], row[1], int(row[2])) for row in mb_r.all()]
        )
        if qv:
            qlow = qv.lower()
            merged = [(n, c) for n, c in merged if qlow in n.lower()]
        return [DashboardNameCount(name=n, count=c) for n, c in merged[:limit]]

    if kind == "ram":
        ram_r = await db.execute(
            select(_ram_gb_rounded.label("gb_bucket"), func.count()).group_by(_ram_gb_rounded)
        )
        buckets: list[DashboardNameCount] = []
        for row in ram_r.all():
            gb_val, cnt = row[0], int(row[1])
            label = "неизвестно" if gb_val is None else f"{int(round(float(gb_val)))} ГБ"
            buckets.append(DashboardNameCount(name=label, count=cnt))
        buckets = sorted(buckets, key=lambda b: _ram_bucket_sort_key(b.name))
        if qv:
            qlow = qv.lower()
            buckets = [b for b in buckets if qlow in b.name.lower()]
        return buckets[:limit]

    # physical_disk
    pd_r = await db.execute(select(Computer.raw_payload))
    merged = aggregate_pc_disk_catalog([row[0] for row in pd_r.all()])
    if qv:
        qlow = qv.lower()
        merged = [(n, c) for n, c in merged if qlow in n.lower()]
    return [DashboardNameCount(name=n, count=c) for n, c in merged[:limit]]


@router.get("/catalog-hosts", response_model=SoftwareInstallHosts)
async def unified_catalog_hosts(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    kind: str = Query(..., pattern=f"^({_CATALOG_KINDS})$"),
    name: str = Query(..., min_length=1, max_length=512),
    limit: int = Query(500, ge=1, le=1000),
):
    """Список ПК по выбранной строке каталога — с ОС, ОЗУ, дисками (как drilldown дашборда)."""
    name_s = name.strip()
    try:
        computers, total = await fetch_segment_computers(db, kind=kind, name=name_s, limit=limit)
        vols = await volumes_by_computer(db, [c.id for c in computers])
        assignee_map = await _assignee_names_for_computers(db, computers)
    except Exception:
        logger.exception("dashboard catalog-hosts failed kind=%s", kind)
        return SoftwareInstallHosts(name=name_s, hostnames=[], total=0, items=[])
    items: list[DashboardSegmentComputer] = []
    for c in computers:
        try:
            items.append(
                DashboardSegmentComputer(
                    **build_segment_computer_row(
                        c,
                        vols.get(c.id, []),
                        assigned_user_name=assignee_map.get(c.id),
                    )
                )
            )
        except Exception:
            logger.exception("catalog-hosts row failed computer_id=%s", getattr(c, "id", None))
    return SoftwareInstallHosts(
        name=name_s,
        hostnames=[(c.hostname or f"#{c.id}") for c in computers],
        total=total,
        items=items,
    )


@router.post("/catalog-filter-hosts", response_model=CatalogFilterHostsResponse)
async def catalog_filter_hosts(
    body: CatalogFilterHostsRequest,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Список ПК по нескольким фильтрам каталога одновременно (логика AND)."""
    cleaned: list[CatalogFilterItem] = []
    for f in body.filters:
        kind = (f.kind or "").strip()
        name = (f.name or "").strip()
        if not kind or not name:
            continue
        if not re.fullmatch(_CATALOG_KINDS, kind):
            raise HTTPException(status_code=400, detail=f"Неизвестный вид фильтра: {kind}")
        cleaned.append(CatalogFilterItem(kind=kind, name=name))
    if not cleaned:
        raise HTTPException(status_code=400, detail="Укажите хотя бы один фильтр")

    try:
        computers, total = await fetch_computers_matching_filters(
            db,
            filters=[(f.kind, f.name) for f in cleaned],
            limit=body.limit,
        )
        vols = await volumes_by_computer(db, [c.id for c in computers])
        assignee_map = await _assignee_names_for_computers(db, computers)
    except Exception:
        logger.exception("dashboard catalog-filter-hosts failed")
        return CatalogFilterHostsResponse(filters=cleaned, total=0, hostnames=[], items=[])
    items: list[DashboardSegmentComputer] = []
    for c in computers:
        try:
            items.append(
                DashboardSegmentComputer(
                    **build_segment_computer_row(
                        c,
                        vols.get(c.id, []),
                        assigned_user_name=assignee_map.get(c.id),
                    )
                )
            )
        except Exception:
            logger.exception("catalog-filter-hosts row failed computer_id=%s", getattr(c, "id", None))
    return CatalogFilterHostsResponse(
        filters=cleaned,
        total=total,
        hostnames=[(c.hostname or f"#{c.id}") for c in computers],
        items=items,
    )


async def _assignee_names_for_computers(
    db: AsyncSession,
    computers: list[Computer],
) -> dict[int, str]:
    user_ids = {int(c.assigned_user_id) for c in computers if c.assigned_user_id is not None}
    if not user_ids:
        return {}
    r = await db.execute(select(User).where(User.id.in_(user_ids)))
    users = {u.id: u for u in r.scalars().all()}
    out: dict[int, str] = {}
    for c in computers:
        if c.assigned_user_id is None:
            continue
        u = users.get(int(c.assigned_user_id))
        if not u:
            continue
        label = ((u.full_name or "").strip() or (u.username or "").strip())
        if label:
            out[c.id] = label
    return out
