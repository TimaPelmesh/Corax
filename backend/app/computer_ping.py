"""Fleet ICMP status — fast enough, network-safe (batched + limited concurrency)."""

from __future__ import annotations

import asyncio
import random
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.computer_ip import resolve_computer_ipv4
from app.config import settings
from app.models import Computer
from app.printer_poll import ping_ip

# Prevent overlapping cycles if a previous sweep is still running.
_cycle_lock = asyncio.Lock()


def _resolve_ip(c: Computer) -> str | None:
    return resolve_computer_ipv4(
        ip_address=getattr(c, "ip_address", None),
        hostname=c.hostname,
        mac_primary=c.mac_primary,
        raw_payload=c.raw_payload,
    )


def _clamp_settings() -> dict[str, int | bool]:
    interval = max(5, min(int(getattr(settings, "computer_ping_interval_minutes", 15) or 15), 180))
    concurrency = max(1, min(int(getattr(settings, "computer_ping_concurrency", 3) or 3), 8))
    batch_size = max(2, min(int(getattr(settings, "computer_ping_batch_size", 10) or 10), 40))
    batch_pause_ms = max(50, min(int(getattr(settings, "computer_ping_batch_pause_ms", 350) or 350), 5000))
    timeout_ms = max(300, min(int(getattr(settings, "computer_ping_timeout_ms", 700) or 700), 2500))
    jitter_ms = max(0, min(int(getattr(settings, "computer_ping_jitter_ms", 40) or 40), 500))
    return {
        "interval_minutes": interval,
        "concurrency": concurrency,
        "batch_size": batch_size,
        "batch_pause_ms": batch_pause_ms,
        "timeout_ms": timeout_ms,
        "jitter_ms": jitter_ms,
    }


def _stale_key(c: Computer) -> tuple[int, float]:
    """Oldest / never-pinged first."""
    ts = c.last_ping_at
    if ts is None:
        return (0, 0.0)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (1, ts.timestamp())


async def _ping_batch(
    items: list[tuple[int, str]],
    *,
    concurrency: int,
    timeout_ms: int,
    jitter_ms: int,
) -> dict[int, bool]:
    """Ping one batch with a semaphore; small jitter so starts are not identical."""
    sem = asyncio.Semaphore(concurrency)
    out: dict[int, bool] = {}

    async def one(cid: int, ip: str) -> None:
        async with sem:
            if jitter_ms:
                await asyncio.sleep(random.uniform(0, jitter_ms / 1000.0))
            out[cid] = await ping_ip(ip, timeout_ms=timeout_ms)

    await asyncio.gather(*(one(cid, ip) for cid, ip in items))
    return out


async def run_computer_ping_cycle(db: AsyncSession, *, reason: str = "scheduler") -> dict[str, Any]:
    """
    Full fleet sweep in careful batches:
    - sort by staleness (never / oldest first)
    - only N hosts in flight at once
    - pause between batches so switches/AP are not flooded
    - commit after each batch → UI indicators update progressively
    """
    if _cycle_lock.locked():
        return {"skipped": True, "reason": "already_running"}

    async with _cycle_lock:
        cfg = _clamp_settings()
        concurrency = int(cfg["concurrency"])
        batch_size = int(cfg["batch_size"])
        batch_pause_ms = int(cfg["batch_pause_ms"])
        timeout_ms = int(cfg["timeout_ms"])
        jitter_ms = int(cfg["jitter_ms"])

        t0 = time.monotonic()
        rows = (await db.execute(select(Computer))).scalars().all()
        rows_sorted = sorted(rows, key=_stale_key)

        targets: list[tuple[int, str]] = []
        by_id: dict[int, Computer] = {}
        skipped_no_ip = 0

        for c in rows_sorted:
            by_id[c.id] = c
            ip = _resolve_ip(c)
            if not ip:
                if (c.ping_status or "") != "unknown":
                    c.ping_status = "unknown"
                skipped_no_ip += 1
                continue
            if not (c.ip_address or "").strip():
                c.ip_address = ip
            targets.append((c.id, ip))

        if skipped_no_ip:
            await db.commit()

        online = 0
        offline = 0
        batches = 0

        for i in range(0, len(targets), batch_size):
            chunk = targets[i : i + batch_size]
            batches += 1
            results = await _ping_batch(
                chunk,
                concurrency=concurrency,
                timeout_ms=timeout_ms,
                jitter_ms=jitter_ms,
            )
            now = datetime.now(timezone.utc)
            for cid, ok in results.items():
                c = by_id.get(cid)
                if not c:
                    continue
                c.ping_status = "online" if ok else "offline"
                c.last_ping_at = now
                if ok:
                    online += 1
                else:
                    offline += 1
            await db.commit()
            # Ensure next API reads see committed statuses (no stale identity map).
            db.expire_all()

            # Pause between batches (not after the last one).
            if i + batch_size < len(targets):
                await asyncio.sleep(batch_pause_ms / 1000.0)

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return {
            "skipped": False,
            "reason": reason,
            "polled": len(targets),
            "online": online,
            "offline": offline,
            "skipped_no_ip": skipped_no_ip,
            "batches": batches,
            "concurrency": concurrency,
            "batch_size": batch_size,
            "batch_pause_ms": batch_pause_ms,
            "timeout_ms": timeout_ms,
            "elapsed_ms": elapsed_ms,
        }


async def run_computer_ping_drip(db: AsyncSession, *, limit: int | None = None) -> dict[str, Any]:
    """
    Small incremental pass: only the most stale hosts.
    Used by the rolling ticker so load is spread across the whole interval.
    """
    cfg = _clamp_settings()
    concurrency = int(cfg["concurrency"])
    batch_size = int(cfg["batch_size"])
    timeout_ms = int(cfg["timeout_ms"])
    jitter_ms = int(cfg["jitter_ms"])
    n = max(1, min(int(limit or batch_size), 40))

    rows = (await db.execute(select(Computer))).scalars().all()
    candidates: list[tuple[Computer, str]] = []
    for c in rows:
        ip = _resolve_ip(c)
        if not ip:
            continue
        if not (c.ip_address or "").strip():
            c.ip_address = ip
        candidates.append((c, ip))

    candidates.sort(key=lambda x: _stale_key(x[0]))
    slice_ = candidates[:n]
    if not slice_:
        return {"polled": 0, "online": 0, "offline": 0, "mode": "drip"}

    items = [(c.id, ip) for c, ip in slice_]
    by_id = {c.id: c for c, _ in slice_}
    results = await _ping_batch(
        items,
        concurrency=concurrency,
        timeout_ms=timeout_ms,
        jitter_ms=jitter_ms,
    )
    now = datetime.now(timezone.utc)
    online = 0
    offline = 0
    for cid, ok in results.items():
        c = by_id[cid]
        c.ping_status = "online" if ok else "offline"
        c.last_ping_at = now
        if ok:
            online += 1
        else:
            offline += 1
    await db.commit()
    db.expire_all()
    return {
        "polled": len(items),
        "online": online,
        "offline": offline,
        "mode": "drip",
        "concurrency": concurrency,
        "timeout_ms": timeout_ms,
    }
