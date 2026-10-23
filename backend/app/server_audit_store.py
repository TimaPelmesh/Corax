"""Store Linux audit samples and decide when the agent should collect."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_policy import hostnames_match
from app.models import Computer, ServerAuditHost, ServerAuditSample

_KEEP_DAYS = 30
_KEEP_MAX = 3000
_PAYLOAD_MAX = 180_000
ALLOWED_INTERVALS = frozenset({0, 5, 15, 30, 60, 180, 360, 720, 1440})


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


def metrics_from_payload(payload: dict[str, Any]) -> dict[str, float | int | None]:
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    memory = payload.get("memory") if isinstance(payload.get("memory"), dict) else {}
    load = payload.get("load") if isinstance(payload.get("load"), dict) else {}
    cpu = payload.get("cpu") if isinstance(payload.get("cpu"), dict) else {}
    return {
        "cpu_temp_c": _fnum(summary.get("cpu_temp_c"), 1, 125, 1),
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


def trim_payload(payload: dict[str, Any]) -> str:
    data = dict(payload)
    text = json.dumps(data, ensure_ascii=False)
    if len(text) <= _PAYLOAD_MAX:
        return text
    for key in ("processes", "listeners", "docker", "failed_units", "disk_io"):
        if isinstance(data.get(key), list):
            data[key] = data[key][:8]
    text = json.dumps(data, ensure_ascii=False)
    if len(text) <= _PAYLOAD_MAX:
        return text
    slim = {
        "hostname": data.get("hostname"),
        "collected_at": data.get("collected_at"),
        "agent_version": data.get("agent_version"),
        "summary": data.get("summary") if isinstance(data.get("summary"), dict) else {},
        "os": data.get("os") if isinstance(data.get("os"), dict) else {},
        "truncated": True,
    }
    return json.dumps(slim, ensure_ascii=False)[:_PAYLOAD_MAX]


def os_summary_from_payload(payload: dict[str, Any]) -> str | None:
    os_block = payload.get("os") if isinstance(payload.get("os"), dict) else {}
    pretty = str(os_block.get("pretty") or "").strip()
    kernel = str(os_block.get("kernel") or "").strip()
    text = " · ".join(part for part in (pretty, kernel) if part)
    return text[:255] or None


async def find_audit_host(db: AsyncSession, hostname: str) -> ServerAuditHost | None:
    key = (hostname or "").strip().lower()
    if not key:
        return None
    exact = (
        await db.execute(
            select(ServerAuditHost).where(func.lower(ServerAuditHost.hostname) == key).limit(1)
        )
    ).scalar_one_or_none()
    if exact is not None:
        return exact
    rows = (await db.execute(select(ServerAuditHost))).scalars().all()
    matched = [row for row in rows if hostnames_match(hostname, row.hostname)]
    if len(matched) == 1:
        return matched[0]
    return None


async def _link_computer(db: AsyncSession, host: ServerAuditHost, hostname: str) -> None:
    key = hostname.strip().lower()
    pc = (
        await db.execute(select(Computer).where(func.lower(Computer.hostname) == key).limit(1))
    ).scalar_one_or_none()
    if pc is not None:
        host.computer_id = pc.id


async def _prune(db: AsyncSession, host_id: int, now: datetime) -> None:
    cutoff = now - timedelta(days=_KEEP_DAYS)
    await db.execute(
        delete(ServerAuditSample).where(
            ServerAuditSample.host_id == host_id,
            ServerAuditSample.collected_at < cutoff,
        )
    )
    count = await db.scalar(
        select(func.count()).select_from(ServerAuditSample).where(ServerAuditSample.host_id == host_id)
    )
    extra = int(count or 0) - _KEEP_MAX
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
    """Append a point when the hostname is enrolled. Does not commit."""
    host = await find_audit_host(db, hostname)
    if host is None:
        return {"ok": True, "stored": False, "reason": "not_enrolled"}
    if not host.enabled:
        return {"ok": True, "stored": False, "reason": "disabled", "host_id": host.id}

    now = datetime.now(timezone.utc)
    metrics = metrics_from_payload(payload)
    sample = ServerAuditSample(
        host_id=host.id,
        collected_at=_parse_when(payload.get("collected_at"), now),
        cpu_temp_c=metrics["cpu_temp_c"],
        cpu_used_percent=metrics["cpu_used_percent"],
        load_1=metrics["load_1"],
        mem_used_percent=int(metrics["mem_used_percent"]) if metrics["mem_used_percent"] is not None else None,
        swap_used_percent=int(metrics["swap_used_percent"]) if metrics["swap_used_percent"] is not None else None,
        disk_used_percent=int(metrics["disk_used_percent"]) if metrics["disk_used_percent"] is not None else None,
        net_rx_bps=metrics["net_rx_bps"],
        net_tx_bps=metrics["net_tx_bps"],
        uptime_sec=metrics["uptime_sec"],
        payload_json=trim_payload(payload),
    )
    db.add(sample)
    host.last_sample_at = sample.collected_at
    host.collect_requested = False
    host.latest_cpu_temp_c = metrics["cpu_temp_c"]
    host.latest_cpu_percent = metrics["cpu_used_percent"]
    host.latest_mem_percent = metrics["mem_used_percent"]
    host.latest_disk_percent = metrics["disk_used_percent"]
    host.latest_load_1 = metrics["load_1"]
    summary = os_summary_from_payload(payload)
    if summary:
        host.os_summary = summary
    await _link_computer(db, host, hostname)
    await db.flush()
    await _prune(db, host.id, now)
    return {"ok": True, "stored": True, "reason": "stored", "host_id": host.id}


async def audit_directive(db: AsyncSession, hostname: str) -> dict[str, Any]:
    host = await find_audit_host(db, hostname)
    if host is None:
        return {"collect": False, "reason": "not_enrolled", "interval_minutes": 0, "hostname": hostname}
    if not host.enabled:
        return {
            "collect": False,
            "reason": "disabled",
            "interval_minutes": int(host.interval_minutes or 0),
            "hostname": host.hostname,
        }
    interval = int(host.interval_minutes or 0)
    if host.collect_requested:
        return {
            "collect": True,
            "reason": "requested",
            "interval_minutes": interval,
            "hostname": host.hostname,
        }
    if interval <= 0:
        return {"collect": False, "reason": "idle", "interval_minutes": 0, "hostname": host.hostname}
    last = host.last_sample_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    due = last is None or (datetime.now(timezone.utc) - last).total_seconds() >= interval * 60
    return {
        "collect": due,
        "reason": "interval" if due else "idle",
        "interval_minutes": interval,
        "hostname": host.hostname,
    }
