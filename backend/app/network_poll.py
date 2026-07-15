from __future__ import annotations

import inspect
import json
import platform
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

ProgressCb = Callable[[str, int, str], Awaitable[None] | None]  # noqa: UP007

from app.async_pool import run_async_pool
from app.models import NetworkDevice, NetworkPollConfig
from app.network_classify import NETWORK_DEVICE_TYPES, network_dedupe_key_for_ip
from app.network_link_builder import rebuild_all_links
from app.network_poll_config import get_effective_network_poll_config, get_network_poll_config_row
from app.network_snmp import NetworkSnmpSnapshot, fetch_network_snmp, probe_network_snmp
from app.network_snmp_discover import discover_network_devices, upsert_discovered_device
from app.printer_poll_config import get_effective_printer_poll_config

_WIN32 = platform.system().lower() == "windows"
_IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


@dataclass
class NetworkPollResult:
    polled: int = 0
    online: int = 0
    offline: int = 0
    snmp_ok: int = 0
    snmp_error: int = 0
    duration_ms: int = 0
    discovered: int = 0
    discovery_created: int = 0
    discovery_updated: int = 0
    neighbor_seeded: int = 0
    links_devices: int = 0
    links_computers: int = 0
    message: str = ""
    networks: list[str] = field(default_factory=list)


async def _apply_snapshot(row: NetworkDevice, snap, now: datetime) -> None:
    if snap.sys_name:
        row.sys_name = snap.sys_name
        row.hostname = snap.sys_name[:255]
    if snap.sys_descr:
        row.sys_descr = snap.sys_descr
    if snap.sys_object_id:
        row.sys_object_id = snap.sys_object_id
    if snap.sys_location:
        row.location = snap.sys_location
    if snap.device_type and snap.device_type not in {"printer", "host"}:
        row.device_type = snap.device_type if snap.device_type in NETWORK_DEVICE_TYPES else "unknown"
    if snap.vendor:
        row.vendor = snap.vendor
    row.interfaces_json = json.dumps([i.to_dict() for i in snap.interfaces], ensure_ascii=False)
    row.neighbors_json = json.dumps([n.to_dict() for n in snap.neighbors], ensure_ascii=False)
    row.fdb_json = json.dumps([f.to_dict() for f in snap.fdb], ensure_ascii=False)
    extras: dict[str, Any] = {}
    if getattr(snap, "sys_uptime_ticks", None) is not None:
        extras["sys_uptime_ticks"] = snap.sys_uptime_ticks
        extras["sys_uptime_human"] = getattr(snap, "sys_uptime_human", None)
    if getattr(snap, "ip_addresses", None):
        extras["ip_addresses"] = list(snap.ip_addresses)
    if getattr(snap, "sys_contact", None):
        extras["sys_contact"] = snap.sys_contact
    if getattr(snap, "model", None):
        extras["model"] = snap.model
    if getattr(snap, "serial_number", None):
        extras["serial_number"] = snap.serial_number
    if getattr(snap, "classify_confidence", None) is not None:
        extras["classify_confidence"] = round(float(snap.classify_confidence or 0), 2)
    if getattr(snap, "classify_signals", None):
        extras["classify_signals"] = list(snap.classify_signals)
    if getattr(snap, "ip_forwarding", None) is not None:
        extras["ip_forwarding"] = bool(snap.ip_forwarding)
    if getattr(snap, "bridge_num_ports", None) is not None:
        extras["bridge_num_ports"] = int(snap.bridge_num_ports)
    if_up = sum(1 for i in snap.interfaces if i.oper_status == "up")
    eth = sum(1 for i in snap.interfaces if (i.if_type or 0) in {6, 62, 69, 117, 55})
    wifi = sum(1 for i in snap.interfaces if (i.if_type or 0) in {71, 168, 169, 188})
    extras["interfaces_total"] = len(snap.interfaces)
    extras["interfaces_up"] = if_up
    extras["ethernet_ports"] = eth
    extras["wifi_ports"] = wifi
    extras["neighbors_total"] = len(snap.neighbors)
    extras["fdb_total"] = len(snap.fdb)
    if hasattr(row, "extras_json"):
        row.extras_json = json.dumps(extras, ensure_ascii=False)
    row.last_snmp_at = now
    if snap.error and not snap.sys_descr:
        row.snmp_status = "error"
        row.snmp_error = snap.error
    else:
        row.snmp_status = "ok"
        row.snmp_error = snap.error
        row.last_seen_at = now


async def _extra_communities(db: AsyncSession, primary: str) -> list[str]:
    out: list[str] = []
    try:
        pcfg = await get_effective_printer_poll_config(db)
        if pcfg.snmp_community and pcfg.snmp_community.strip() != primary.strip():
            out.append(pcfg.snmp_community.strip())
    except Exception:
        pass
    return out


def _candidate_ip(raw: str | None, known: set[str]) -> str | None:
    rip = (raw or "").strip()
    if not rip or not _IP_RE.match(rip) or rip in known:
        return None
    parts = rip.split(".")
    try:
        if not all(0 <= int(p) <= 255 for p in parts):
            return None
    except ValueError:
        return None
    if parts[-1] in {"0", "255"}:
        return None
    return rip


async def enrich_discovered_for_neighbors(
    db: AsyncSession,
    *,
    community: str,
    timeout: float = 3.5,
    limit: int = 48,
) -> int:
    """Deep-poll recently found devices so LLDP/CDP/FDB become available for seeding."""
    rows = (
        await db.execute(select(NetworkDevice).order_by(NetworkDevice.last_seen_at.desc().nulls_last()))
    ).scalars().all()
    targets: list[NetworkDevice] = []
    for row in rows:
        if len(targets) >= limit:
            break
        # Prefer devices without neighbor data yet
        has_nb = False
        if row.neighbors_json:
            try:
                has_nb = bool(json.loads(row.neighbors_json))
            except json.JSONDecodeError:
                has_nb = False
        if has_nb:
            continue
        if row.snmp_status == "error":
            continue
        targets.append(row)

    if not targets:
        # Still refresh a few newest even if they have neighbors
        targets = list(rows[: min(12, limit)])

    if not targets:
        return 0

    done = 0

    async def one(row: NetworkDevice) -> None:
        nonlocal done
        snap = await fetch_network_snmp(row.ip_address, community=community, timeout=timeout)
        if snap.sys_descr or snap.sys_name or snap.interfaces or snap.neighbors:
            await _apply_snapshot(row, snap, datetime.now(timezone.utc))
            done += 1

    await run_async_pool(targets, one, concurrency=min(6 if _WIN32 else 10, len(targets)))
    await db.commit()
    return done


async def seed_devices_from_neighbors(
    db: AsyncSession,
    *,
    community: str,
    timeout: float = 1.2,
) -> int:
    """Create/update network_devices from LLDP/CDP neighbor IPs and device IP lists."""
    devices = (await db.execute(select(NetworkDevice))).scalars().all()
    known_ips = {d.ip_address.strip() for d in devices if d.ip_address}
    candidates: dict[str, str] = {}  # ip -> hint name

    for d in devices:
        if d.neighbors_json:
            try:
                neighbors = json.loads(d.neighbors_json) or []
            except json.JSONDecodeError:
                neighbors = []
            for n in neighbors:
                if not isinstance(n, dict):
                    continue
                hint = (n.get("remote_name") or "").strip()
                for key in ("remote_ip", "remote_name"):
                    rip = _candidate_ip(n.get(key) if key == "remote_ip" else None, known_ips)
                    if rip is None and key == "remote_name":
                        # hostname that is literally an IP
                        rip = _candidate_ip(hint, known_ips)
                    if rip:
                        candidates[rip] = hint or candidates.get(rip, "")
        if getattr(d, "extras_json", None):
            try:
                extras = json.loads(d.extras_json) or {}
            except json.JSONDecodeError:
                extras = {}
            for raw in extras.get("ip_addresses") or []:
                rip = _candidate_ip(str(raw), known_ips)
                if rip and rip != d.ip_address:
                    candidates.setdefault(rip, f"ip-from {d.hostname or d.ip_address}")

    if not candidates:
        return 0

    probed: list[tuple[str, NetworkSnmpSnapshot | None]] = []

    async def probe_one(ip: str) -> None:
        snap = await probe_network_snmp(ip, community=community, timeout=timeout)
        if snap.device_type in {"printer", "host"}:
            return
        if snap.sys_descr or snap.sys_name or snap.sys_object_id:
            probed.append((ip, snap))
        else:
            # Keep as topology stub even without SNMP
            probed.append((ip, None))

    await run_async_pool(
        list(candidates.keys()),
        probe_one,
        concurrency=min(16 if _WIN32 else 24, max(1, len(candidates))),
    )

    seeded = 0
    now = datetime.now(timezone.utc)
    for ip, snap in probed:
        if snap is None:
            hint = candidates.get(ip) or f"neighbor {ip}"
            dedupe = network_dedupe_key_for_ip(ip)
            existing = (
                await db.execute(
                    select(NetworkDevice).where(
                        (NetworkDevice.ip_address == ip) | (NetworkDevice.dedupe_key == dedupe)
                    ).limit(1)
                )
            ).scalar_one_or_none()
            if existing is None:
                db.add(
                    NetworkDevice(
                        dedupe_key=dedupe,
                        ip_address=ip,
                        hostname=hint[:255],
                        device_type="unknown",
                        snmp_status="unknown",
                        source="neighbor",
                        last_seen_at=now,
                    )
                )
                seeded += 1
            continue
        action = await upsert_discovered_device(db, ip, snap, now=now, source="neighbor")
        if action == "created":
            seeded += 1

    await db.commit()
    return seeded


async def poll_single_device(
    db: AsyncSession,
    device_id: int,
    *,
    community: str | None = None,
    timeout: float | None = None,
    rebuild_links: bool = True,
) -> NetworkDevice:
    cfg = await get_effective_network_poll_config(db)
    row = (await db.execute(select(NetworkDevice).where(NetworkDevice.id == device_id))).scalar_one_or_none()
    if row is None:
        raise LookupError("device not found")
    snap = await fetch_network_snmp(
        row.ip_address,
        community=community or cfg.snmp_community,
        timeout=timeout or cfg.snmp_timeout_seconds,
    )
    now = datetime.now(timezone.utc)
    await _apply_snapshot(row, snap, now)
    await db.commit()
    await db.refresh(row)
    if rebuild_links:
        await seed_devices_from_neighbors(db, community=cfg.snmp_community)
        await rebuild_all_links(db)
        await db.refresh(row)
    return row


async def _emit(cb: ProgressCb | None, phase: str, pct: int, msg: str) -> None:
    if cb is None:
        return
    out = cb(phase, pct, msg)
    if inspect.isawaitable(out):
        await out


async def run_network_poll_cycle(
    db: AsyncSession,
    *,
    with_discovery: bool = True,
    triggered_by: str = "manual",
    progress_cb: ProgressCb | None = None,
) -> NetworkPollResult:
    started = time.monotonic()
    result = NetworkPollResult()
    cfg = await get_effective_network_poll_config(db)
    extra = await _extra_communities(db, cfg.snmp_community)

    if with_discovery:
        await _emit(progress_cb, "discover", 8, "Авто-зона CORAX (интерфейсы, шлюз, маршруты, ARP)…")
        disc = await discover_network_devices(
            db,
            community=cfg.snmp_community,
            communities=extra,
            timeout=min(1.4, max(0.7, cfg.snmp_timeout_seconds)),
            total_budget_seconds=360.0,
            concurrency=max(cfg.poll_concurrency, 24),
            cidr_list=cfg.cidr_list or None,
        )
        result.discovered = disc.found
        result.discovery_created = disc.created
        result.discovery_updated = disc.updated
        result.networks = disc.networks
        why = "; ".join((disc.scope_reasons or [])[:2])
        await _emit(
            progress_cb,
            "discover",
            35,
            f"Зона: {', '.join(disc.networks[:4]) or '—'}. Найдено SNMP: {disc.found}"
            + (f" ({why})" if why else ""),
        )

    devices = (await db.execute(select(NetworkDevice).order_by(NetworkDevice.id.asc()))).scalars().all()
    if not devices and not with_discovery:
        result.message = "Нет устройств для опроса. Запустите discovery."
        result.duration_ms = int((time.monotonic() - started) * 1000)
        return result

    await _emit(progress_cb, "deep_poll", 40, f"Глубокий опрос {len(devices)} устройств…")
    workers = max(1, min(cfg.poll_concurrency, 8 if _WIN32 else 16))
    now = datetime.now(timezone.utc)
    lock_results: list[tuple[int, NetworkSnmpSnapshot]] = []
    total = max(1, len(devices))
    done_count = 0

    async def worker(dev: NetworkDevice) -> None:
        nonlocal done_count
        snap = await fetch_network_snmp(
            dev.ip_address,
            community=cfg.snmp_community,
            timeout=max(cfg.snmp_timeout_seconds, 4.0),
        )
        if snap.error and not snap.sys_descr and extra:
            for comm in extra:
                snap2 = await fetch_network_snmp(
                    dev.ip_address,
                    community=comm,
                    timeout=max(cfg.snmp_timeout_seconds, 4.0),
                )
                if snap2.sys_descr or not snap2.error:
                    snap = snap2
                    break
        lock_results.append((dev.id, snap))
        done_count += 1
        pct = 40 + int(40 * done_count / total)
        await _emit(progress_cb, "deep_poll", pct, f"Опрос SNMP {done_count}/{total}…")

    await run_async_pool(list(devices), worker, workers)

    by_id = {d.id: d for d in (await db.execute(select(NetworkDevice))).scalars().all()}
    for device_id, snap in lock_results:
        row = by_id.get(device_id)
        if row is None:
            continue
        result.polled += 1
        await _apply_snapshot(row, snap, now)
        if snap.error and not snap.sys_descr:
            result.snmp_error += 1
            result.offline += 1
        else:
            result.snmp_ok += 1
            result.online += 1

    await db.commit()

    await _emit(progress_cb, "neighbors", 82, "Сбор соседей LLDP/CDP…")
    result.neighbor_seeded = await seed_devices_from_neighbors(
        db, community=cfg.snmp_community, timeout=min(1.2, cfg.snmp_timeout_seconds)
    )

    await _emit(progress_cb, "links", 90, "Построение связей с ПК…")
    links = await rebuild_all_links(db)
    result.links_devices = links.device_links
    result.links_computers = links.computer_links

    result.duration_ms = int((time.monotonic() - started) * 1000)
    summary = {
        "triggered_by": triggered_by,
        "polled": result.polled,
        "online": result.online,
        "offline": result.offline,
        "discovered": result.discovered,
        "neighbor_seeded": result.neighbor_seeded,
        "links_devices": result.links_devices,
        "links_computers": result.links_computers,
        "duration_ms": result.duration_ms,
    }
    cfg_row: NetworkPollConfig = await get_network_poll_config_row(db)
    cfg_row.last_run_at = datetime.now(timezone.utc)
    cfg_row.last_run_summary_json = json.dumps(summary, ensure_ascii=False)
    await db.commit()

    result.message = (
        f"Опрос сети: {result.online}/{result.polled} online, "
        f"discovery +{result.discovery_created}/~{result.discovery_updated}, "
        f"соседи +{result.neighbor_seeded}, "
        f"связи ПК: {result.links_computers}, устройства: {result.links_devices} "
        f"({result.duration_ms} мс)"
    )
    await _emit(progress_cb, "links", 96, result.message)
    return result
