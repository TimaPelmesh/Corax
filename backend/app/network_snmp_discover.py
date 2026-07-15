from __future__ import annotations

import ipaddress
import json
import platform
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.async_pool import run_async_pool
from app.local_ip import (
    arp_table_ipv4,
    default_gateway_ipv4,
    discover_corax_network_scope,
    dns_server_ipv4,
)
from app.models import NetworkDevice
from app.network_classify import network_dedupe_key_for_ip
from app.network_snmp import NetworkSnmpSnapshot, probe_network_snmp

# Full /24 = 254 hosts. Windows select() ~512 → keep concurrency under ~48.
_MAX_HOSTS_PER_NETWORK = 1022
_MAX_DISCOVERY_IPS = 6144
_MAX_SUBNETS = 48
_WIN32 = platform.system().lower() == "windows"
_DEFAULT_DISCOVERY_CONCURRENCY = 28 if _WIN32 else 48

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
    """
    if cidr_list:
        nets = _private_networks_from_cidrs(cidr_list)
        if nets:
            return nets
    scope = discover_corax_network_scope(max_subnets=_MAX_SUBNETS)
    return list(scope.networks)


def resolve_discovery_networks(
    cidr_list: list[str] | None = None,
) -> tuple[list[ipaddress.IPv4Network], list[str]]:
    """Return networks + human reasons for UI/logs."""
    if cidr_list:
        nets = _private_networks_from_cidrs(cidr_list)
        if nets:
            return nets, [f"ручной CIDR: {', '.join(str(n) for n in nets[:12])}"]
    scope = discover_corax_network_scope(max_subnets=_MAX_SUBNETS)
    return list(scope.networks), list(scope.reasons)


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
    """Discovery recall: keep almost any SNMP responder except printers/PCs."""
    if snap.device_type in {"printer", "host"}:
        return False
    if snap.is_network_gear:
        return True
    if snap.sys_descr or snap.sys_name or snap.sys_object_id:
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
    dtype = snap.device_type if snap.device_type not in {"printer", "host"} else "unknown"
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
                location=snap.sys_location,
                snmp_status="ok",
                snmp_error=None,
                last_snmp_at=now,
                last_seen_at=now,
                source=source,
                extras_json=extras_raw,
            )
        )
        return "created"
    existing.dedupe_key = dedupe_key
    existing.ip_address = ip
    existing.hostname = hostname
    existing.sys_name = snap.sys_name or existing.sys_name
    existing.sys_descr = snap.sys_descr or existing.sys_descr
    existing.sys_object_id = snap.sys_object_id or existing.sys_object_id
    if snap.device_type and snap.device_type not in {"printer", "host"}:
        existing.device_type = snap.device_type
    existing.vendor = snap.vendor or existing.vendor
    if snap.sys_location:
        existing.location = snap.sys_location
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
    return "updated"


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
) -> NetworkDiscoveryResult:
    started = time.monotonic()
    deadline = started + max(30.0, total_budget_seconds)
    result = NetworkDiscoveryResult()
    networks, reasons = resolve_discovery_networks(cidr_list)
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
    hot = set(seed_list)

    ips: list[str] = []
    truncated = False

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
        unique_ips = unique_ips[:_MAX_DISCOVERY_IPS]
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
            snap = await probe_network_snmp(ip, community=comm, timeout=timeout)
            if snap.error and not snap.sys_descr and not snap.sys_name and not snap.sys_object_id:
                last_err = True
                continue
            if not snap.sys_descr and not snap.sys_name and not snap.sys_object_id:
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

    await db.commit()
    result.duration_ms = int((time.monotonic() - started) * 1000)
    limit_note = " (сканирование ограничено по числу адресов)" if truncated else ""
    timed_out = time.monotonic() >= deadline
    time_note = " Бюджет времени исчерпан — повторите скан." if timed_out else ""
    nets_s = ", ".join(result.networks[:8])
    if len(result.networks) > 8:
        nets_s += f" …+{len(result.networks) - 8}"
    why = "; ".join(reasons[:4])
    scope_note = f" Зона CORAX: {why}." if why else ""
    stub_note = f", stub без SNMP +{stub_created}" if stub_created else ""
    if result.found or stub_created:
        result.message = (
            f"Network discovery: просканировано {result.scanned} адресов ({nets_s}), "
            f"seed {result.seed_ips}, SNMP {result.found}, "
            f"+{result.created}/~{result.updated}, пропущено {result.skipped}"
            f"{stub_note}.{scope_note}{limit_note}{time_note}"
        )
    else:
        result.message = (
            f"Network discovery: {result.duration_ms} мс, сканов {result.scanned} ({nets_s}), "
            f"seed {result.seed_ips} — SNMP-ответов нет. "
            f"Проверьте community/UDP 161.{scope_note}{limit_note}{time_note}"
        )
    return result


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
    stub_offsets = {1, 2, 3, 4, 5, 10, 20, 50, 100, 200, 250, 251, 252, 253, 254}
    candidates: list[tuple[str, str]] = []
    for ip in seed_list:
        if ip in found_ips:
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
