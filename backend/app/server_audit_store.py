"""Store Linux audit samples and decide when the agent should collect."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.orm import load_only
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_policy import hostnames_match
from app.models import Computer, ServerAuditHost, ServerAuditSample

_KEEP_MAX = 1500
JOURNAL_MODES = frozenset({"off", "errors", "all"})
JOURNAL_LINES = frozenset({0, 10, 20, 40, 80})
RETAIN_DAYS = frozenset({7, 14, 30, 90})
_ERROR_LEVELS = frozenset({"emerg", "alert", "crit", "err", "error", "fatal"})
_PAYLOAD_MAX = 180_000
ALLOWED_INTERVALS = frozenset({0, 15, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400})
_HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$")
_AUTO_INTERVAL_MIN = 5
_AUTO_INTERVAL_SEC = 300
_KEEP_CEILING = 80_000
_BUCKET_KEYS = (
    "cpu_temp_c",
    "gpu_temp_c",
    "cpu_used_percent",
    "mem_used_percent",
    "swap_used_percent",
    "disk_used_percent",
    "load_1",
    "net_rx_bps",
    "net_tx_bps",
)


def _fnum(value: Any, lo: float, hi: float, digits: int = 1) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number < lo or number > hi:
        return None
    return round(number, digits)


def _inum(value: Any, lo: int, hi: int) -> int | None:
    number = _fnum(value, lo, hi, 0)
    if number is None:
        return None
    return int(number)


def _gpu_temp(payload: dict[str, Any], summary: dict[str, Any]) -> float | None:
    direct = _fnum(summary.get("gpu_temp_c"), 1, 125, 1)
    if direct is not None:
        return direct
    values: list[float] = []
    gpus = payload.get("gpus")
    if isinstance(gpus, list):
        for row in gpus:
            if isinstance(row, dict):
                reading = _fnum(row.get("temp_c"), 1, 125, 1)
                if reading is not None:
                    values.append(reading)
    temps = payload.get("temperatures")
    if isinstance(temps, list):
        for row in temps:
            if not isinstance(row, dict):
                continue
            blob = f"{row.get('source') or ''} {row.get('name') or ''} {row.get('kind') or ''}".lower()
            if not any(token in blob for token in ("nvidia", "amdgpu", "radeon", "nouveau", "gpu", "vga")):
                continue
            reading = _fnum(row.get("celsius"), 1, 125, 1)
            if reading is not None:
                values.append(reading)
    if not values:
        return None
    return round(max(values), 1)


def metrics_from_payload(payload: dict[str, Any]) -> dict[str, float | int | None]:
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    memory = payload.get("memory") if isinstance(payload.get("memory"), dict) else {}
    load = payload.get("load") if isinstance(payload.get("load"), dict) else {}
    cpu = payload.get("cpu") if isinstance(payload.get("cpu"), dict) else {}
    return {
        "cpu_temp_c": _fnum(summary.get("cpu_temp_c"), 1, 125, 1),
        "gpu_temp_c": _gpu_temp(payload, summary),
        "cpu_used_percent": _fnum(
            summary.get("cpu_used_percent", cpu.get("used_percent")), 0, 100, 1
        ),
        "load_1": _fnum(summary.get("load_1", load.get("1")), 0, 10000, 2),
        "mem_used_percent": _fnum(
            summary.get("mem_used_percent", memory.get("used_percent")), 0, 100, 0
        ),
        "swap_used_percent": _fnum(
            summary.get("swap_used_percent", memory.get("swap_used_percent")), 0, 100, 0
        ),
        "disk_used_percent": _fnum(summary.get("disk_used_percent"), 0, 100, 0),
        "net_rx_bps": _fnum(summary.get("net_rx_bps"), 0, 1e12, 1),
        "net_tx_bps": _fnum(summary.get("net_tx_bps"), 0, 1e12, 1),
        "uptime_sec": _inum(summary.get("uptime_sec", payload.get("uptime_sec")), 0, 10**10),
    }


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def interval_seconds_of(host: ServerAuditHost) -> int:
    raw = getattr(host, "interval_seconds", None)
    if raw is not None:
        return max(0, int(raw))
    return max(0, int(host.interval_minutes or 0) * 60)


def minutes_mirror(seconds: int) -> int:
    """Old agents only understand minutes. Sub-minute schedules collect once a minute until the script updates."""
    if seconds <= 0:
        return 0
    if seconds < 60:
        return 1
    return seconds // 60


def keep_cap(interval_seconds: int) -> int:
    """14 days at the chosen interval, so a 15s schedule is not thrown away after six hours."""
    if interval_seconds <= 0:
        return _KEEP_MAX
    span = int((14 * 86400) / max(interval_seconds, 1))
    return max(_KEEP_MAX, min(span, _KEEP_CEILING))


def bucket_downsample(rows: list, cap: int = 800) -> list:
    """Keep the first, last, min and max of each series inside a time bucket so a spike survives the cap."""
    if len(rows) <= cap:
        return rows
    bucket_count = max(1, cap // 20)
    step = len(rows) / bucket_count
    picked: list = []
    seen: set[int] = set()
    for index in range(bucket_count):
        start = int(index * step)
        end = len(rows) if index == bucket_count - 1 else int((index + 1) * step)
        chunk = rows[start:end]
        if not chunk:
            continue
        chosen = [chunk[0], chunk[-1]]
        for key in _BUCKET_KEYS:
            valued: list[tuple[float, Any]] = []
            for row in chunk:
                value = getattr(row, key, None)
                if value is None:
                    continue
                valued.append((float(value), row))
            if not valued:
                continue
            chosen.append(min(valued, key=lambda item: item[0])[1])
            chosen.append(max(valued, key=lambda item: item[0])[1])
        for row in sorted(chosen, key=lambda item: item.collected_at):
            marker = id(row)
            if marker in seen:
                continue
            seen.add(marker)
            picked.append(row)
    return picked


_CHART_FIELDS = (
    "id",
    "collected_at",
    "cpu_temp_c",
    "gpu_temp_c",
    "cpu_used_percent",
    "load_1",
    "mem_used_percent",
    "swap_used_percent",
    "disk_used_percent",
    "net_rx_bps",
    "net_tx_bps",
    "uptime_sec",
)
# One winner per series, plus the first and last point of the bucket.
_CHART_RANK_KEYS = _BUCKET_KEYS


def _chart_sql(rank_keys: tuple[str, ...]) -> str:
    ranks = [
        "row_number() OVER (PARTITION BY bucket ORDER BY collected_at ASC) AS rn_first",
        "row_number() OVER (PARTITION BY bucket ORDER BY collected_at DESC) AS rn_last",
    ]
    keep = ["rn_first = 1", "rn_last = 1"]
    for key in rank_keys:
        alias = f"rn_{key}"
        ranks.append(
            f"row_number() OVER (PARTITION BY bucket ORDER BY {key} DESC NULLS LAST, collected_at) AS {alias}"
        )
        keep.append(f"{alias} = 1")
    fields = ", ".join(_CHART_FIELDS)
    return f"""
WITH scoped AS (
    SELECT {fields}
    FROM server_audit_samples
    WHERE host_id = :host_id AND collected_at >= :since
),
bounds AS (
    SELECT min(collected_at) AS t0, max(collected_at) AS t1
    FROM scoped
),
bucketed AS (
    SELECT s.*,
           width_bucket(
               CAST(extract(epoch FROM s.collected_at) AS float8),
               CAST(extract(epoch FROM b.t0) AS float8),
               CAST(extract(epoch FROM b.t1) + 0.001 AS float8),
               :buckets
           ) AS bucket
    FROM scoped s
    CROSS JOIN bounds b
    WHERE b.t1 > b.t0
),
ranked AS (
    SELECT *,
           {", ".join(ranks)}
    FROM bucketed
)
SELECT {fields}
FROM ranked
WHERE {" OR ".join(keep)}
ORDER BY collected_at ASC
"""


_CHART_SQL = text(_chart_sql(_CHART_RANK_KEYS))


def _chart_row(row) -> SimpleNamespace:
    data = row._mapping
    return SimpleNamespace(**{key: data[key] for key in _CHART_FIELDS})


async def _load_chart_rows(db: AsyncSession, host_id: int, since: datetime) -> list:
    columns = [getattr(ServerAuditSample, name) for name in _CHART_FIELDS]
    rows = (
        await db.execute(
            select(ServerAuditSample)
            .options(load_only(*columns))
            .where(ServerAuditSample.host_id == host_id, ServerAuditSample.collected_at >= since)
            .order_by(ServerAuditSample.collected_at.asc())
        )
    ).scalars().all()
    return list(rows)


async def load_chart_samples(db: AsyncSession, host_id: int, since: datetime, cap: int = 800) -> list:
    """Points for one host chart.

    A short range comes back whole, so a small fleet looks the same as before.
    A long range is reduced in Postgres: each time bucket keeps its ends and the
    peak of every series, and the process never receives tens of thousands of rows.
    """
    total = int(
        await db.scalar(
            select(func.count())
            .select_from(ServerAuditSample)
            .where(ServerAuditSample.host_id == host_id, ServerAuditSample.collected_at >= since)
        )
        or 0
    )
    if total == 0:
        return []
    if total <= cap:
        return await _load_chart_rows(db, host_id, since)
    buckets = max(1, cap // (len(_CHART_RANK_KEYS) + 2))
    picked = [
        _chart_row(row)
        for row in (
            await db.execute(
                _CHART_SQL,
                {"host_id": host_id, "since": since, "buckets": buckets},
            )
        ).all()
    ]
    if not picked:
        rows = await _load_chart_rows(db, host_id, since)
        return bucket_downsample(rows, cap)
    if len(picked) > cap:
        return bucket_downsample(picked, cap)
    return picked


def _due(last: datetime | None, now: datetime, interval_sec: int) -> bool:
    """True when the interval has elapsed. A future stamp is not due (the agent clock still sends)."""
    last_utc = _utc(last)
    if last_utc is None:
        return True
    return (now - last_utc).total_seconds() >= interval_sec


def _parse_when(raw: Any, now: datetime) -> datetime:
    if not isinstance(raw, str) or not raw.strip():
        return now
    text = raw.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return now
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    if abs((now - parsed).total_seconds()) > 2 * 86400:
        return now
    return parsed


def _cap_list(data: dict[str, Any], key: str, limit: int) -> None:
    if isinstance(data.get(key), list) and len(data[key]) > limit:
        data[key] = data[key][:limit]


def shape_payload(payload: dict[str, Any], *, journal_mode: str, journal_lines: int) -> str:
    """Keep chart fields. Journal text stays only as configured, and only on this sample."""
    data = dict(payload)
    logs = data.get("logs") if isinstance(data.get("logs"), list) else []
    mode = journal_mode if journal_mode in JOURNAL_MODES else "errors"
    limit = journal_lines if journal_lines in JOURNAL_LINES else 20
    if mode == "off" or limit <= 0:
        kept: list[Any] = []
    elif mode == "errors":
        kept = [
            row
            for row in logs
            if isinstance(row, dict) and str(row.get("level") or "").lower() in _ERROR_LEVELS
        ][:limit]
    else:
        kept = [row for row in logs if isinstance(row, dict)][:limit]
    data["logs"] = kept
    if not kept:
        data.pop("logs_source", None)
    for key, cap in (
        ("processes", 20),
        ("listeners", 40),
        ("docker", 20),
        ("disk_io", 16),
        ("disks", 24),
        ("temperatures", 48),
        ("voltages", 16),
        ("gpus", 8),
    ):
        _cap_list(data, key, cap)
    return trim_payload(data)


def _without_logs(raw: str | None) -> str | None:
    if not raw or '"logs"' not in raw:
        return raw
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if not isinstance(data, dict) or not data.get("logs"):
        return raw
    data["logs"] = []
    data.pop("logs_source", None)
    return json.dumps(data, ensure_ascii=False)


def trim_payload(payload: dict[str, Any]) -> str:
    data = dict(payload)
    text = json.dumps(data, ensure_ascii=False)
    if len(text) <= _PAYLOAD_MAX:
        return text
    _cap_list(data, "logs", 40)
    for key in ("processes", "listeners", "docker", "failed_units", "disk_io"):
        _cap_list(data, key, 8)
    text = json.dumps(data, ensure_ascii=False)
    if len(text) <= _PAYLOAD_MAX:
        return text
    logs = data.get("logs") if isinstance(data.get("logs"), list) else []
    slim = {
        "hostname": data.get("hostname"),
        "collected_at": data.get("collected_at"),
        "agent_version": data.get("agent_version"),
        "summary": data.get("summary") if isinstance(data.get("summary"), dict) else {},
        "os": data.get("os") if isinstance(data.get("os"), dict) else {},
        "logs_source": data.get("logs_source"),
        "logs": logs[:20],
        "truncated": True,
    }
    return json.dumps(slim, ensure_ascii=False)[:_PAYLOAD_MAX]


def os_summary_from_payload(payload: dict[str, Any]) -> str | None:
    os_block = payload.get("os") if isinstance(payload.get("os"), dict) else {}
    pretty = str(os_block.get("pretty") or "").strip()
    kernel = str(os_block.get("kernel") or "").strip()
    text = " · ".join(part for part in (pretty, kernel) if part)
    return text[:255] or None


def _host_names(hostname: str, payload: dict[str, Any] | None = None) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    raw_names = [hostname]
    if payload:
        fqdn = payload.get("hostname_fqdn")
        if isinstance(fqdn, str):
            raw_names.append(fqdn)
        aliases = payload.get("aliases")
        if isinstance(aliases, list):
            raw_names.extend(str(item) for item in aliases)
    for raw in raw_names:
        text = (raw or "").strip().rstrip(".")
        key = text.lower()
        if not text or key in seen or not _HOST_RE.match(text):
            continue
        seen.add(key)
        names.append(text[:255])
    return names


async def find_audit_host(
    db: AsyncSession,
    hostname: str,
    payload: dict[str, Any] | None = None,
) -> ServerAuditHost | None:
    names = _host_names(hostname, payload)
    if not names:
        return None
    for name in names:
        exact = (
            await db.execute(
                select(ServerAuditHost).where(func.lower(ServerAuditHost.hostname) == name.lower()).limit(1)
            )
        ).scalar_one_or_none()
        if exact is not None:
            return exact
    rows = (await db.execute(select(ServerAuditHost))).scalars().all()
    matched: list[ServerAuditHost] = []
    seen_ids: set[int] = set()
    for row in rows:
        if row.id in seen_ids:
            continue
        if any(hostnames_match(name, row.hostname) for name in names):
            seen_ids.add(row.id)
            matched.append(row)
    if len(matched) == 1:
        return matched[0]
    return None


async def _enroll_host(db: AsyncSession, hostname: str) -> ServerAuditHost | None:
    """First report from a cluster token creates the host. Disabled hosts are not recreated."""
    name = (hostname or "").strip().rstrip(".")[:255]
    if not _HOST_RE.match(name):
        return None
    host = ServerAuditHost(
        hostname=name,
        enabled=True,
        interval_minutes=_AUTO_INTERVAL_MIN,
        interval_seconds=_AUTO_INTERVAL_SEC,
        collect_requested=False,
        journal_mode="errors",
        journal_lines=20,
        retain_days=14,
    )
    try:
        async with db.begin_nested():
            db.add(host)
            await db.flush()
    except IntegrityError:
        return await find_audit_host(db, name)
    await _link_computer(db, host, name)
    return host


async def _link_computer(db: AsyncSession, host: ServerAuditHost, hostname: str) -> None:
    key = hostname.strip().lower()
    pc = (
        await db.execute(select(Computer).where(func.lower(Computer.hostname) == key).limit(1))
    ).scalar_one_or_none()
    if pc is not None:
        host.computer_id = pc.id


async def _prune(db: AsyncSession, host_id: int, now: datetime, retain_days: int, interval_seconds: int = 900) -> None:
    days = retain_days if retain_days in RETAIN_DAYS else 14
    cutoff = now - timedelta(days=days)
    await db.execute(
        delete(ServerAuditSample).where(
            ServerAuditSample.host_id == host_id,
            ServerAuditSample.collected_at < cutoff,
        )
    )
    count = await db.scalar(
        select(func.count()).select_from(ServerAuditSample).where(ServerAuditSample.host_id == host_id)
    )
    extra = int(count or 0) - keep_cap(interval_seconds)
    if extra <= 0:
        return
    old_ids = list(
        (
            await db.execute(
                select(ServerAuditSample.id)
                .where(ServerAuditSample.host_id == host_id)
                .order_by(ServerAuditSample.collected_at.asc())
                .limit(extra)
            )
        ).scalars().all()
    )
    if old_ids:
        await db.execute(delete(ServerAuditSample).where(ServerAuditSample.id.in_(old_ids)))


async def record_audit_sample(db: AsyncSession, hostname: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Append a point. An unknown host is enrolled on the first valid report. Does not commit."""
    host = await find_audit_host(db, hostname, payload)
    if host is None:
        host = await _enroll_host(db, hostname)
    if host is None:
        return {"ok": True, "stored": False, "reason": "bad_hostname"}
    if not host.enabled:
        return {"ok": True, "stored": False, "reason": "disabled", "host_id": host.id}

    now = datetime.now(timezone.utc)
    metrics = metrics_from_payload(payload)
    sample = ServerAuditSample(
        host_id=host.id,
        collected_at=_parse_when(payload.get("collected_at"), now),
        cpu_temp_c=metrics["cpu_temp_c"],
        gpu_temp_c=metrics["gpu_temp_c"],
        cpu_used_percent=metrics["cpu_used_percent"],
        load_1=metrics["load_1"],
        mem_used_percent=int(metrics["mem_used_percent"]) if metrics["mem_used_percent"] is not None else None,
        swap_used_percent=int(metrics["swap_used_percent"]) if metrics["swap_used_percent"] is not None else None,
        disk_used_percent=int(metrics["disk_used_percent"]) if metrics["disk_used_percent"] is not None else None,
        net_rx_bps=metrics["net_rx_bps"],
        net_tx_bps=metrics["net_tx_bps"],
        uptime_sec=metrics["uptime_sec"],
        payload_json=shape_payload(
            payload,
            journal_mode=str(host.journal_mode or "errors"),
            journal_lines=int(host.journal_lines or 0),
        ),
    )
    db.add(sample)
    host.last_sample_at = sample.collected_at
    host.collect_requested = False
    host.latest_cpu_temp_c = metrics["cpu_temp_c"]
    host.latest_gpu_temp_c = metrics["gpu_temp_c"]
    host.latest_cpu_percent = metrics["cpu_used_percent"]
    host.latest_mem_percent = metrics["mem_used_percent"]
    host.latest_disk_percent = metrics["disk_used_percent"]
    host.latest_load_1 = metrics["load_1"]
    summary = os_summary_from_payload(payload)
    if summary:
        host.os_summary = summary
    await _link_computer(db, host, hostname)
    await db.flush()
    await _drop_older_payloads(db, host.id, sample.id)
    await _prune(db, host.id, now, int(host.retain_days or 14), interval_seconds_of(host))
    return {"ok": True, "stored": True, "reason": "stored", "host_id": host.id, "hostname": host.hostname}


async def _drop_older_payloads(db: AsyncSession, host_id: int, keep_id: int) -> None:
    """Charts read numeric columns. The snapshot payload stays on the newest sample only."""
    await db.execute(
        update(ServerAuditSample)
        .where(
            ServerAuditSample.host_id == host_id,
            ServerAuditSample.id != keep_id,
            ServerAuditSample.payload_json.is_not(None),
        )
        .values(payload_json=None)
    )


async def apply_journal_now(db: AsyncSession, host: ServerAuditHost) -> None:
    """Retention and an empty journal take effect without waiting for the next sample."""
    now = datetime.now(timezone.utc)
    await _prune(db, host.id, now, int(host.retain_days or 14), interval_seconds_of(host))
    if (host.journal_mode or "errors") != "off":
        return
    rows = list(
        (
            await db.execute(
                select(ServerAuditSample)
                .where(ServerAuditSample.host_id == host.id)
                .order_by(ServerAuditSample.collected_at.desc())
                .limit(40)
            )
        ).scalars().all()
    )
    for row in rows:
        slim = _without_logs(row.payload_json)
        if slim is not None and slim != row.payload_json:
            row.payload_json = slim


def _directive(host: ServerAuditHost, collect: bool, reason: str) -> dict[str, Any]:
    seconds = interval_seconds_of(host)
    return {
        "collect": collect,
        "reason": reason,
        "interval_seconds": seconds,
        "interval_minutes": minutes_mirror(seconds),
        "hostname": host.hostname,
    }


async def audit_directive(db: AsyncSession, hostname: str) -> dict[str, Any]:
    host = await find_audit_host(db, hostname)
    if host is None:
        # Unknown host still collects. The following POST creates the row.
        return {
            "collect": True,
            "reason": "enroll",
            "interval_seconds": _AUTO_INTERVAL_SEC,
            "interval_minutes": _AUTO_INTERVAL_MIN,
            "hostname": hostname,
        }
    if not host.enabled:
        return _directive(host, False, "disabled")
    seconds = interval_seconds_of(host)
    if host.collect_requested:
        return _directive(host, True, "requested")
    if seconds <= 0:
        return _directive(host, False, "idle")
    due = _due(host.last_sample_at, datetime.now(timezone.utc), seconds)
    return _directive(host, due, "interval" if due else "idle")
