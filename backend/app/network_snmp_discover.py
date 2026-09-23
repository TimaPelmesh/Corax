from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import platform
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.async_pool import run_async_pool
from app.local_ip import (
    advertise_lan_ipv4,
    arp_table_ipv4,
    default_gateway_ipv4,
    dns_server_ipv4,
    resolve_lan_scan_networks,
)
from app.computer_ip import primary_ipv4_from_raw_payload
from app.models import Computer, NetworkDevice, Printer
from app.network_classify import (
    NETWORK_DEVICE_TYPES,
    location_is_manual,
    network_dedupe_key_for_ip,
    network_type_is_manual,
    usable_sys_location,
)
from app.network_snmp import NetworkSnmpSnapshot, probe_has_signal, probe_network_snmp
from app.printer_cleanup import printer_dedupe_key_for_ip, snmp_tab_clause
from app.printer_poll import ping_ip

log = logging.getLogger(__name__)

# Full /24 = 254 hosts. Windows select() ~512 → keep concurrency under ~48.
_MAX_HOSTS_PER_NETWORK = 1022
_MAX_DISCOVERY_IPS = 6144
_MAX_SUBNETS = 96
_WIN32 = platform.system().lower() == "windows"
_DEFAULT_DISCOVERY_CONCURRENCY = 28 if _WIN32 else 48

# Careful ICMP sweep after SNMP (не забиваем подсеть).
_PING_CONCURRENCY = 4 if _WIN32 else 6
_PING_BATCH_SIZE = 12
_PING_BATCH_PAUSE_MS = 450
_PING_JITTER_MS = 60
_PING_TIMEOUT_MS = 800
_PING_BUDGET_SECONDS = 300.0


@dataclass
class NetworkDiscoveryResult:
    scanned: int = 0
    found: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: int = 0
    duration_ms: int = 0
    networks: list[str] = field(default_factory=list)
    scope_reasons: list[str] = field(default_factory=list)
    seed_ips: int = 0
    inventory_seeded: int = 0
    ping_scanned: int = 0
    ping_alive: int = 0
    ping_created: int = 0
    message: str = ""


def _private_networks_from_cidrs(cidrs: list[str]) -> list[ipaddress.IPv4Network]:
    networks: set[ipaddress.IPv4Network] = set()
    for raw in cidrs:
        try:
            net = ipaddress.ip_network(raw.strip(), strict=False)
        except ValueError:
            continue
        if not isinstance(net, ipaddress.IPv4Network):
            continue
        if not (net.is_private or net.is_link_local):
            continue
        if net.prefixlen < 16:
            continue
        if net.prefixlen < 24:
            count = 0
            for subnet in net.subnets(new_prefix=24):
                networks.add(subnet)
                count += 1
                if count >= _MAX_SUBNETS:
                    break
        else:
            networks.add(net)
    return sorted(networks, key=lambda n: int(n.network_address))


def local_network_snmp_networks(cidr_list: list[str] | None = None) -> list[ipaddress.IPv4Network]:
    """
    Auto scope from CORAX host topology (interfaces → gateway → routes → ARP).
    Manual CIDR in settings overrides auto-detection.
    Docker 172.x bridges are never scanned as if they were the office LAN.
    """
    nets, _reasons = resolve_lan_scan_networks(cidr_list=cidr_list, max_subnets=_MAX_SUBNETS)
    return nets


def resolve_discovery_networks(
    cidr_list: list[str] | None = None,
    hint_ips: list[str] | None = None,
    *,
    exclusive: bool = False,
) -> tuple[list[ipaddress.IPv4Network], list[str]]:
    """Return networks + human reasons for UI/logs."""
    return resolve_lan_scan_networks(
        cidr_list=cidr_list,
        hint_ips=hint_ips,
        max_subnets=_MAX_SUBNETS,
        exclusive=exclusive,
    )


def _infra_seed_ips(networks: list[ipaddress.IPv4Network]) -> list[str]:
    """Gateways, DNS, ARP neighbors, and classic infra offsets — probe first."""
    seeds: list[str] = []
    seen: set[str] = set()
    net_set = set(networks)

    def add(ip: ipaddress.IPv4Address | str) -> None:
        s = str(ip)
        if s in seen:
            return
        try:
            addr = ipaddress.ip_address(s)
        except ValueError:
            return
        if not isinstance(addr, ipaddress.IPv4Address):
            return
        if addr.is_loopback or addr.is_link_local or addr.is_multicast:
            return
        last = int(addr) & 0xFF
        if last in {0, 255}:
            return
        # Prefer seeds inside resolved scope (ARP from other nets still OK if in scope)
        if net_set and not any(addr in n for n in net_set):
            return
        seen.add(s)
        seeds.append(s)

    for gw in default_gateway_ipv4():
        add(gw)
    for dns in dns_server_ipv4():
        add(dns)
    adv = advertise_lan_ipv4()
    if adv:
        add(adv)
    for arp in arp_table_ipv4():
        add(arp)

    preferred = (
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
        20, 21, 22, 24, 25, 30, 50, 51, 64, 100, 101, 110, 120,
        150, 200, 210, 220, 240, 241, 242, 243, 244, 245, 246, 247,
        248, 249, 250, 251, 252, 253, 254,
    )
    for net in networks:
        base = int(net.network_address)
        for off in preferred:
            cand = ipaddress.IPv4Address(base + off)
            if cand in net and cand != net.broadcast_address:
                add(cand)

    return seeds


def _prioritize_hosts(
    hosts: list[ipaddress.IPv4Address],
    *,
    hot: set[str],
) -> list[ipaddress.IPv4Address]:
    if not hosts:
        return hosts
    preferred_offsets = {
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 20, 24, 25, 50,
        100, 101, 200, 240, 250, 251, 252, 253, 254,
    }

    def sort_key(ip: ipaddress.IPv4Address) -> tuple[int, int]:
        s = str(ip)
        if s in hot:
            return (0, int(ip) & 0xFF)
        last = int(ip) & 0xFF
        prio = 1 if last in preferred_offsets else 2
        return (prio, last)

    return sorted(hosts, key=sort_key)


def _hostname_from_snap(snap: NetworkSnmpSnapshot, ip: str) -> str:
    name = (snap.sys_name or "").strip()
    if name:
        return name[:255]
    vendor = snap.vendor or "device"
    return f"{vendor} {ip}"[:255]


def _accept_discovered(snap: NetworkSnmpSnapshot) -> bool:
    """Keep network gear, PCs and printers on the Network tab."""
    if snap.device_type in {"printer", "host"}:
        return True
    if snap.is_network_gear:
        return True
    if probe_has_signal(snap):
        return True
    return False


async def upsert_discovered_device(
    db: AsyncSession,
    ip: str,
    snap: NetworkSnmpSnapshot,
    *,
    now: datetime | None = None,
    source: str = "snmp",
) -> str:
    """Insert or update a device. Returns 'created' | 'updated'."""
    now = now or datetime.now(timezone.utc)
    dedupe_key = network_dedupe_key_for_ip(ip)
    existing = (
        await db.execute(
            select(NetworkDevice).where(
                (NetworkDevice.ip_address == ip) | (NetworkDevice.dedupe_key == dedupe_key)
            ).limit(1)
        )
    ).scalar_one_or_none()
    hostname = _hostname_from_snap(snap, ip)
    dtype = snap.device_type or "unknown"
    if dtype not in NETWORK_DEVICE_TYPES:
        dtype = "unknown"
    light_extras: dict = {}
    if getattr(snap, "model", None):
        light_extras["model"] = snap.model
    if getattr(snap, "serial_number", None):
        light_extras["serial_number"] = snap.serial_number
    if getattr(snap, "classify_confidence", None) is not None:
        light_extras["classify_confidence"] = round(float(snap.classify_confidence or 0), 2)
    if getattr(snap, "classify_signals", None):
        light_extras["classify_signals"] = list(snap.classify_signals)[:24]
    extras_raw = json.dumps(light_extras, ensure_ascii=False) if light_extras else None
    action = "updated"
    if existing is None:
        db.add(
            NetworkDevice(
                dedupe_key=dedupe_key,
                ip_address=ip,
                hostname=hostname,
                sys_name=snap.sys_name,
                sys_descr=snap.sys_descr,
                sys_object_id=snap.sys_object_id,
                device_type=dtype,
                vendor=snap.vendor,
                location=usable_sys_location(snap.sys_location),
                snmp_status="ok",
                snmp_error=None,
                last_snmp_at=now,
                last_seen_at=now,
                source=source,
                extras_json=extras_raw,
            )
        )
        action = "created"
    else:
        existing.dedupe_key = dedupe_key
        existing.ip_address = ip
        existing.hostname = hostname
        existing.sys_name = snap.sys_name or existing.sys_name
        existing.sys_descr = snap.sys_descr or existing.sys_descr
        existing.sys_object_id = snap.sys_object_id or existing.sys_object_id
        if snap.device_type and not network_type_is_manual(getattr(existing, "extras_json", None)):
            existing.device_type = dtype
        existing.vendor = snap.vendor or existing.vendor
        if snap.sys_location and not location_is_manual(getattr(existing, "extras_json", None)):
            loc = usable_sys_location(snap.sys_location)
            if loc:
                existing.location = loc
        existing.snmp_status = "ok"
        existing.snmp_error = None
        existing.last_snmp_at = now
        existing.last_seen_at = now
        if extras_raw and hasattr(existing, "extras_json"):
            try:
                prev = json.loads(existing.extras_json) if existing.extras_json else {}
            except (TypeError, json.JSONDecodeError):
                prev = {}
            if not isinstance(prev, dict):
                prev = {}
            prev.update(light_extras)
            existing.extras_json = json.dumps(prev, ensure_ascii=False)
    await sync_printer_from_network_snap(db, ip, snap, now=now, snmp_status="ok")
    return action


async def sync_printer_from_network_snap(
    db: AsyncSession,
    ip: str,
    snap: NetworkSnmpSnapshot,
    *,
    now: datetime,
    snmp_status: str = "ok",
) -> None:
    """Keep the Printers tab in sync when Network SNMP classifies a printer."""
    if (snap.device_type or "") != "printer":
        return
    ip = (ip or "").strip()
    if not ip:
        return
    dedupe_key = printer_dedupe_key_for_ip(ip)
    existing = (
        await db.execute(
            select(Printer).where((Printer.ip_address == ip) | (Printer.dedupe_key == dedupe_key)).limit(1)
        )
    ).scalar_one_or_none()
    model = (getattr(snap, "model", None) or snap.sys_name or "").strip() or None
    title = (model or snap.sys_name or f"SNMP printer {ip}").splitlines()[0].strip()[:512]
    if existing is None:
        db.add(
            Printer(
                dedupe_key=dedupe_key,
                name=title,
                ip_address=ip,
                is_network=True,
                source="snmp",
                poll_status="online" if snmp_status == "ok" else "offline",
                snmp_status=snmp_status,
                snmp_error=None if snmp_status == "ok" else (snap.error or None),
                snmp_model=model,
                snmp_sys_name=snap.sys_name,
                location=usable_sys_location(snap.sys_location),
                last_seen_at=now,
                last_poll_at=now,
                last_snmp_at=now,
            )
        )
        return
    existing.dedupe_key = dedupe_key
    existing.ip_address = ip
    existing.is_network = True
    if existing.source in {None, "", "agent"}:
        existing.source = "snmp"
    existing.poll_status = "online" if snmp_status == "ok" else (existing.poll_status or "offline")
    existing.snmp_status = snmp_status
    if snmp_status == "ok":
        existing.snmp_error = None
    elif snap.error:
        existing.snmp_error = snap.error
    if model:
        existing.snmp_model = model
    if snap.sys_name:
        existing.snmp_sys_name = snap.sys_name
    if (
        snap.sys_location
        and not getattr(existing, "location_manual", False)
        and not (existing.location or "").strip()
    ):
        loc = usable_sys_location(snap.sys_location)
        if loc:
            existing.location = loc[:255]
    existing.last_seen_at = now
    existing.last_poll_at = now
    existing.last_snmp_at = now
    current = (existing.name or "").strip()
    if not current or current == ip:
        existing.name = title


def _merge_communities(primary: str, extra: list[str] | None) -> list[str]:
    """Only communities from settings / linked printer config — nothing hardcoded."""
    out: list[str] = []
    for c in [primary, *(extra or [])]:
        c = (c or "").strip()
        if c and c not in out:
            out.append(c)
    return out


async def discover_network_devices(
    db: AsyncSession,
    *,
    community: str = "public",
    communities: list[str] | None = None,
    timeout: float = 1.0,
    total_budget_seconds: float = 420.0,
    concurrency: int = 32,
    cidr_list: list[str] | None = None,
    exclusive: bool = False,
    expand_neighbors: bool = True,
) -> NetworkDiscoveryResult:
    started = time.monotonic()
    deadline = started + max(30.0, total_budget_seconds)
    result = NetworkDiscoveryResult()
    inventory_pcs = await _inventory_pc_entries(db, networks=None)
    extra_hints = await _known_device_ips(db)
    hint_ips = [ip for ip, _hn in inventory_pcs] + extra_hints
    networks, reasons = resolve_discovery_networks(cidr_list, hint_ips=hint_ips, exclusive=exclusive)
    result.networks = [str(n) for n in networks]
    result.scope_reasons = reasons

    if not networks:
        result.message = (
            "Не удалось автоматически определить зону CORAX "
            "(нет LAN IP / маршрутов). Задайте CIDR в настройках."
        )
        return result

    try_comms = _merge_communities(community, communities)
    seed_list = _infra_seed_ips(networks)
    result.seed_ips = len(seed_list)
    # Приоритет SNMP/ping — только IP в зоне CORAX; на карту сидим все известные ПК.
    inventory_in_zone = [(ip, hn) for ip, hn in inventory_pcs if _ip_in_networks(ip, networks)]
    inventory_ip_set = {ip for ip, _hn in inventory_pcs}
    extra_in_zone = {ip for ip in extra_hints if _ip_in_networks(ip, networks)}
    zone_ip_set = {ip for ip, _hn in inventory_in_zone}
    hot = set(seed_list) | zone_ip_set | extra_in_zone

    ips: list[str] = []
    truncated = False

    # ПК из инвентаря в зоне — первыми (SNMP редко, но ping надёжнее).
    for ip, _hn in inventory_in_zone:
        ips.append(ip)

    for ip in extra_in_zone:
        ips.append(ip)

    for ip in seed_list:
        ips.append(ip)

    for net in networks:
        hosts = list(net.hosts())
        if len(hosts) > _MAX_HOSTS_PER_NETWORK:
            hosts = hosts[:_MAX_HOSTS_PER_NETWORK]
            truncated = True
        hosts = _prioritize_hosts(hosts, hot=hot)
        ips.extend(str(ip) for ip in hosts)

    seen: set[str] = set()
    unique_ips: list[str] = []
    for ip in ips:
        if ip not in seen:
            seen.add(ip)
            unique_ips.append(ip)
    if len(unique_ips) > _MAX_DISCOVERY_IPS:
        # Сохраняем инвентарные IP зоны даже при обрезке.
        keep = [ip for ip in unique_ips if ip in zone_ip_set]
        rest = [ip for ip in unique_ips if ip not in inventory_ip_set]
        budget = max(0, _MAX_DISCOVERY_IPS - len(keep))
        unique_ips = keep + rest[:budget]
        truncated = True

    workers = max(4, min(concurrency, _DEFAULT_DISCOVERY_CONCURRENCY))
    found: list[tuple[str, NetworkSnmpSnapshot]] = []
    found_ips: set[str] = set()

    async def probe(ip: str) -> None:
        if time.monotonic() >= deadline:
            return
        result.scanned += 1
        last_err = False
        comms = try_comms if ip in hot else try_comms[: max(2, min(4, len(try_comms)))]
        for comm in comms:
            if time.monotonic() >= deadline:
                return
            snap = await probe_network_snmp(
                ip,
                community=comm,
                timeout=timeout,
                allow_v1=ip in hot,
            )
            if snap.error and not probe_has_signal(snap):
                last_err = True
                continue
            if not probe_has_signal(snap):
                return
            if not _accept_discovered(snap):
                result.skipped += 1
                return
            if ip not in found_ips:
                found_ips.add(ip)
                found.append((ip, snap))
            return
        if last_err:
            result.errors += 1

    await run_async_pool(unique_ips, probe, workers)

    now = datetime.now(timezone.utc)
    for ip, snap in found:
        action = await upsert_discovered_device(db, ip, snap, now=now)
        if action == "created":
            result.created += 1
        else:
            result.updated += 1

    result.found = len(found)

    stub_created = await _seed_infra_stubs(
        db,
        seed_list=seed_list,
        found_ips=found_ips,
        now=now,
    )
    result.created += stub_created

    # ПК из парка CORAX — сразу на вкладку «Сеть» (Windows обычно без SNMP).
    inv_created, inv_updated = await _seed_inventory_hosts(
        db,
        pcs=inventory_pcs,
        found_ips=found_ips,
        now=now,
    )
    result.inventory_seeded = inv_created + inv_updated
    result.created += inv_created
    result.updated += inv_updated
    found_ips |= inventory_ip_set

    pr_created, pr_updated = await _seed_inventory_printers(db, found_ips=found_ips, now=now)
    result.created += pr_created
    result.updated += pr_updated

    # Аккуратный ICMP: живые хосты без SNMP (ПК, IoT…) — в базу как устройства.
    ping_alive, ping_created = await _ping_sweep_unknown_hosts(
        db,
        candidate_ips=unique_ips,
        skip_ips=found_ips,
        priority_ips=inventory_ip_set,
        now=now,
        deadline=min(deadline, time.monotonic() + _PING_BUDGET_SECONDS),
        result=result,
    )
    result.ping_alive = ping_alive
    result.ping_created = ping_created
    result.created += ping_created

    await db.commit()

    if expand_neighbors and time.monotonic() < deadline - 20:
        extra_cidrs = await collect_unseen_neighbor_cidrs(db, networks)
        if extra_cidrs:
            extra = await discover_network_devices(
                db,
                community=community,
                communities=communities,
                timeout=timeout,
                total_budget_seconds=max(20.0, deadline - time.monotonic()),
                concurrency=concurrency,
                cidr_list=extra_cidrs,
                exclusive=True,
                expand_neighbors=False,
            )
            result.scanned += extra.scanned
            result.found += extra.found
            result.created += extra.created
            result.updated += extra.updated
            result.skipped += extra.skipped
            result.errors += extra.errors
            for net in extra.networks:
                if net not in result.networks:
                    result.networks.append(net)
            if extra.networks:
                result.scope_reasons.append(
                    "соседи LLDP/CDP/Zabbix → +" + ", ".join(extra.networks[:8])
                )

    result.duration_ms = int((time.monotonic() - started) * 1000)
    limit_note = " (сканирование ограничено по числу адресов)" if truncated else ""
    timed_out = time.monotonic() >= deadline
    time_note = " Бюджет времени исчерпан — повторите скан." if timed_out else ""
    nets_s = ", ".join(result.networks[:8])
    if len(result.networks) > 8:
        nets_s += f" …+{len(result.networks) - 8}"
    why = "; ".join((result.scope_reasons or reasons)[:5])
    scope_note = f" Зона CORAX: {why}." if why else ""
    stub_note = f", stub без SNMP +{stub_created}" if stub_created else ""
    inv_note = f", ПК из инвентаря +{inv_created}/~{inv_updated}" if result.inventory_seeded else ""
    ping_note = (
        f", ping {result.ping_scanned}/{result.ping_alive} живых (+{ping_created})"
        if result.ping_scanned
        else ""
    )
    if result.found or stub_created or ping_created or result.inventory_seeded:
        result.message = (
            f"Network discovery: просканировано {result.scanned} адресов ({nets_s}), "
            f"seed {result.seed_ips}, SNMP {result.found}, "
            f"+{result.created}/~{result.updated}, пропущено {result.skipped}"
            f"{stub_note}{inv_note}{ping_note}.{scope_note}{limit_note}{time_note}"
        )
    else:
        result.message = (
            f"Network discovery: {result.duration_ms} мс, сканов {result.scanned} ({nets_s}), "
            f"seed {result.seed_ips} — SNMP-ответов нет"
            f"{ping_note}. "
            f"Проверьте community/UDP 161.{scope_note}{limit_note}{time_note}"
        )
    return result


def _ip_in_networks(ip_s: str, networks: list[ipaddress.IPv4Network] | None) -> bool:
    if not networks:
        return True
    try:
        addr = ipaddress.ip_address(ip_s)
    except ValueError:
        return False
    if not isinstance(addr, ipaddress.IPv4Address):
        return False
    return any(addr in net for net in networks)


def _private_slash24(raw: str | None) -> str | None:
    ip = str(raw or "").strip().split("/")[0].split(":")[0]
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if not isinstance(addr, ipaddress.IPv4Address):
        return None
    if not addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast:
        return None
    last = int(addr) & 0xFF
    if last in {0, 255}:
        return None
    return str(ipaddress.ip_network(f"{addr}/24", strict=False))


async def collect_unseen_neighbor_cidrs(
    db: AsyncSession,
    known: list[ipaddress.IPv4Network],
    *,
    limit: int = 24,
) -> list[str]:
    """Extra /24s from LLDP/CDP, SNMP IP lists and Zabbix extras — not already scanned."""
    known_set = set(known)
    found: list[str] = []
    seen: set[str] = set()

    def add(raw: str | None) -> None:
        cidr = _private_slash24(raw)
        if not cidr or cidr in seen:
            return
        try:
            net = ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            return
        if net in known_set:
            return
        seen.add(cidr)
        found.append(cidr)

    rows = (await db.execute(select(NetworkDevice.neighbors_json, NetworkDevice.extras_json, NetworkDevice.ip_address))).all()
    for neighbors_raw, extras_raw, ip in rows:
        add(ip)
        if neighbors_raw:
            try:
                neighbors = json.loads(neighbors_raw) or []
            except (TypeError, json.JSONDecodeError):
                neighbors = []
            for item in neighbors:
                if isinstance(item, dict):
                    add(item.get("remote_ip"))
        if extras_raw:
            try:
                extras = json.loads(extras_raw) or {}
            except (TypeError, json.JSONDecodeError):
                extras = {}
            if isinstance(extras, dict):
                for extra_ip in extras.get("ip_addresses") or []:
                    add(str(extra_ip))
                zb = extras.get("zabbix") if isinstance(extras.get("zabbix"), dict) else {}
                add(zb.get("ip") if isinstance(zb, dict) else None)
    return found[: max(0, limit)]


async def _known_device_ips(db: AsyncSession) -> list[str]:
    """IPs already in inventory besides PCs — expand scan scope and probe first."""
    found: list[str] = []
    seen: set[str] = set()

    def add(raw: str | None) -> None:
        ip = str(raw or "").strip().split("/")[0].split(":")[0]
        if not ip or ip in seen:
            return
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return
        if not isinstance(addr, ipaddress.IPv4Address):
            return
        if addr.is_loopback or addr.is_link_local or addr.is_multicast:
            return
        seen.add(ip)
        found.append(ip)

    for (ip,) in (await db.execute(select(Printer.ip_address))).all():
        add(ip)
    for (ip,) in (await db.execute(select(NetworkDevice.ip_address))).all():
        add(ip)
    return found


async def _inventory_pc_entries(
    db: AsyncSession,
    *,
    networks: list[ipaddress.IPv4Network] | None = None,
) -> list[tuple[str, str]]:
    """IP + hostname ПК из инвентаря (колонка IP или payload агента)."""
    rows = (
        await db.execute(
            select(Computer.ip_address, Computer.hostname, Computer.raw_payload, Computer.mac_primary)
        )
    ).all()
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for ip_col, hostname, raw, mac in rows:
        host = str(hostname or "").strip() or "PC"
        ip_s = str(ip_col or "").strip()
        if not ip_s:
            ip_s = primary_ipv4_from_raw_payload(
                raw,
                prefer_mac=str(mac).strip() if mac else None,
            ) or ""
        if not ip_s or ip_s in seen:
            continue
        if not _ip_in_networks(ip_s, networks):
            continue
        seen.add(ip_s)
        out.append((ip_s, host))
    return out


async def _seed_inventory_hosts(
    db: AsyncSession,
    *,
    pcs: list[tuple[str, str]],
    found_ips: set[str],
    now: datetime,
) -> tuple[int, int]:
    """Создать/обновить NetworkDevice для ПК из парка CORAX без ожидания SNMP/ping."""
    created = 0
    updated = 0
    for ip, hostname in pcs:
        dedupe = network_dedupe_key_for_ip(ip)
        label = f"ПК · {hostname}"[:255]
        existing = (
            await db.execute(
                select(NetworkDevice).where(
                    (NetworkDevice.ip_address == ip) | (NetworkDevice.dedupe_key == dedupe)
                ).limit(1)
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.last_seen_at = now
            if existing.device_type in {None, "", "unknown"}:
                existing.device_type = "host"
            if not (existing.hostname or "").strip() or existing.hostname.startswith("Host ·"):
                existing.hostname = label
            if existing.source in {None, "", "arp-seed", "ping"} and ip not in found_ips:
                existing.source = "inventory"
            if existing.notes and "из инвентаря CORAX" in existing.notes:
                existing.notes = None
            updated += 1
            continue
        db.add(
            NetworkDevice(
                dedupe_key=dedupe,
                ip_address=ip,
                hostname=label,
                device_type="host",
                snmp_status="n/a",
                source="inventory",
                last_seen_at=now,
            )
        )
        created += 1
    return created, updated


async def _seed_inventory_printers(
    db: AsyncSession,
    *,
    found_ips: set[str],
    now: datetime,
) -> tuple[int, int]:
    """Put network printers on the Network tab with type printer, not host."""
    rows = (
        await db.execute(
            select(Printer).where(snmp_tab_clause(), Printer.ip_address.is_not(None), Printer.ip_address != "")
        )
    ).scalars().all()
    created = 0
    updated = 0
    for pr in rows:
        ip = (pr.ip_address or "").strip()
        if not ip:
            continue
        title = (pr.snmp_model or pr.name or ip).splitlines()[0].strip()
        label = f"Принтер · {title}"[:255]
        dedupe = network_dedupe_key_for_ip(ip)
        existing = (
            await db.execute(
                select(NetworkDevice).where(
                    (NetworkDevice.ip_address == ip) | (NetworkDevice.dedupe_key == dedupe)
                ).limit(1)
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.last_seen_at = now
            if existing.device_type in {None, "", "unknown", "host"}:
                existing.device_type = "printer"
            host = (existing.hostname or "").strip()
            if not host or host.startswith("Host ·") or host.startswith("ПК ·"):
                existing.hostname = label
            if existing.snmp_status in {None, "", "unknown"} and pr.snmp_status:
                existing.snmp_status = pr.snmp_status
            if not existing.last_snmp_at and pr.last_snmp_at:
                existing.last_snmp_at = pr.last_snmp_at
            if not existing.vendor and pr.snmp_model:
                existing.vendor = (pr.snmp_model or "")[:128]
            updated += 1
            continue
        db.add(
            NetworkDevice(
                dedupe_key=dedupe,
                ip_address=ip,
                hostname=label,
                device_type="printer",
                vendor=(pr.snmp_model or None) and (pr.snmp_model or "")[:128],
                location=pr.location,
                snmp_status=pr.snmp_status or "unknown",
                last_snmp_at=pr.last_snmp_at,
                source="inventory",
                last_seen_at=now,
            )
        )
        found_ips.add(ip)
        created += 1
    return created, updated


async def sync_fleet_into_network_devices(db: AsyncSession, *, include_zabbix: bool = True) -> None:
    """PCs, printers, and Zabbix hosts on the Network tab. Does not ping, SNMP-poll, or trace."""
    now = datetime.now(timezone.utc)
    pcs = await _inventory_pc_entries(db, networks=None)
    await _seed_inventory_hosts(db, pcs=pcs, found_ips=set(), now=now)
    await _seed_inventory_printers(db, found_ips=set(), now=now)
    if not include_zabbix:
        return
    try:
        from app.network_zabbix_merge import merge_zabbix_into_network_devices

        await merge_zabbix_into_network_devices(db)
    except Exception:
        log.warning("zabbix roster sync failed", exc_info=True)


async def _known_host_labels(db: AsyncSession) -> dict[str, tuple[str, str]]:
    """IP → (label, device_type) from PCs / printers."""
    labels: dict[str, tuple[str, str]] = {}
    for ip, hostname in await _inventory_pc_entries(db, networks=None):
        labels[ip] = (f"ПК · {hostname}"[:255], "host")
    pr_r = await db.execute(
        select(Printer.ip_address, Printer.name, Printer.snmp_model).where(
            Printer.ip_address.is_not(None),
            Printer.ip_address != "",
        )
    )
    for ip, name, model in pr_r.all():
        ip_s = str(ip or "").strip()
        if not ip_s or ip_s in labels:
            continue
        title = (str(model or "").strip() or str(name or "").strip() or ip_s)
        labels[ip_s] = (f"Принтер · {title}"[:255], "printer")
    return labels


async def _ping_sweep_unknown_hosts(
    db: AsyncSession,
    *,
    candidate_ips: list[str],
    skip_ips: set[str],
    now: datetime,
    deadline: float,
    result: NetworkDiscoveryResult,
    priority_ips: set[str] | None = None,
) -> tuple[int, int]:
    """
    ICMP по адресам зоны CORAX, где SNMP молчал и устройства ещё нет в базе.
    Батчи + паузы — без шторма по сети.
    """
    existing_r = await db.execute(select(NetworkDevice.ip_address))
    known: set[str] = {str(row[0]).strip() for row in existing_r.all() if row[0]}
    known |= {ip for ip in skip_ips if ip}

    todo = [ip for ip in candidate_ips if ip not in known]
    if not todo:
        return 0, 0

    # Сначала IP из инвентаря / hot — выше шанс уложиться в бюджет ping.
    prio = priority_ips or set()
    if prio:
        head = [ip for ip in todo if ip in prio]
        tail = [ip for ip in todo if ip not in prio]
        todo = head + tail

    labels = await _known_host_labels(db)
    alive: list[str] = []
    sem = asyncio.Semaphore(_PING_CONCURRENCY)

    async def ping_one(ip: str) -> None:
        if time.monotonic() >= deadline:
            return
        result.ping_scanned += 1
        async with sem:
            if _PING_JITTER_MS:
                await asyncio.sleep(random.uniform(0, _PING_JITTER_MS / 1000.0))
            if time.monotonic() >= deadline:
                return
            ok = await ping_ip(ip, _PING_TIMEOUT_MS)
        if ok:
            alive.append(ip)

    for i in range(0, len(todo), _PING_BATCH_SIZE):
        if time.monotonic() >= deadline:
            break
        chunk = todo[i : i + _PING_BATCH_SIZE]
        await asyncio.gather(*(ping_one(ip) for ip in chunk))
        if i + _PING_BATCH_SIZE < len(todo) and time.monotonic() < deadline:
            await asyncio.sleep(_PING_BATCH_PAUSE_MS / 1000.0)

    created = 0
    for ip in alive:
        if ip in known:
            continue
        dedupe = network_dedupe_key_for_ip(ip)
        existing = (
            await db.execute(
                select(NetworkDevice).where(
                    (NetworkDevice.ip_address == ip) | (NetworkDevice.dedupe_key == dedupe)
                ).limit(1)
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.last_seen_at = now
            if existing.snmp_status in {None, "", "unknown"} and not existing.sys_name:
                info = labels.get(ip)
                if info:
                    existing.hostname = info[0]
                    if existing.device_type in {None, "", "unknown"}:
                        existing.device_type = info[1]
            continue
        info = labels.get(ip)
        hostname = info[0] if info else f"Host · {ip}"
        dtype = info[1] if info else "unknown"
        db.add(
            NetworkDevice(
                dedupe_key=dedupe,
                ip_address=ip,
                hostname=hostname[:255],
                device_type=dtype,
                snmp_status="unknown",
                source="ping",
                last_seen_at=now,
            )
        )
        known.add(ip)
        created += 1
    return len(alive), created


async def _seed_infra_stubs(
    db: AsyncSession,
    *,
    seed_list: list[str],
    found_ips: set[str],
    now: datetime,
) -> int:
    """Add gateway/DNS/classic infra IPs even when SNMP is closed."""
    gateways = {str(g) for g in default_gateway_ipv4()}
    dns = {str(d) for d in dns_server_ipv4()}
    advertise = (advertise_lan_ipv4() or "").strip()
    stub_offsets = {1, 2, 3, 4, 5, 10, 20, 50, 100, 200, 250, 251, 252, 253, 254}
    candidates: list[tuple[str, str]] = []
    for ip in seed_list:
        if ip in found_ips or ip == advertise:
            continue
        try:
            last = int(ip.rsplit(".", 1)[-1])
        except ValueError:
            continue
        if ip in gateways:
            candidates.append((ip, "router"))
        elif ip in dns:
            candidates.append((ip, "server"))
        elif last in stub_offsets:
            dtype = "router" if last in {1, 254, 250, 251} else "unknown"
            candidates.append((ip, dtype))
        if len(candidates) >= 80:
            break

    created = 0
    for ip, dtype in candidates:
        dedupe = network_dedupe_key_for_ip(ip)
        existing = (
            await db.execute(
                select(NetworkDevice).where(
                    (NetworkDevice.ip_address == ip) | (NetworkDevice.dedupe_key == dedupe)
                ).limit(1)
            )
        ).scalar_one_or_none()
        if existing is not None:
            continue
        if ip in gateways:
            hostname = f"Gateway · {ip}"
        elif ip in dns:
            hostname = f"DNS · {ip}"
        else:
            hostname = f"Infra · {ip}"
        db.add(
            NetworkDevice(
                dedupe_key=dedupe,
                ip_address=ip,
                hostname=hostname[:255],
                device_type=dtype,
                snmp_status="unknown",
                source="arp-seed",
                last_seen_at=now,
            )
        )
        created += 1
    return created
