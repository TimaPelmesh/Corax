from __future__ import annotations

import ipaddress
import platform
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.async_pool import run_async_pool
from app.computer_ip import primary_ipv4_from_raw_payload
from app.local_ip import (
    _is_likely_container_bridge,
    _private_ipv4,
    resolve_lan_scan_networks,
)
from app.models import Computer, NetworkDevice, Printer
from app.printer_cleanup import printer_dedupe_key_for_ip, is_network_gear_text
from app.printer_snmp import probe_printer_snmp

# Full /24 = 254 hosts. Cap total so one click cannot scan a /16.
_MAX_HOSTS_PER_NETWORK = 254
_MAX_DISCOVERY_IPS = 2048
_MAX_SUBNETS = 16
_WIN32 = platform.system().lower() == "windows"
_DEFAULT_DISCOVERY_CONCURRENCY = 12 if _WIN32 else 48

_PRINTER_OFFSETS = {
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 20, 21, 22, 24, 25,
    30, 32, 40, 50, 51, 60, 64, 70, 80, 90, 100, 101, 110, 120, 128,
    150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 241, 242, 243,
    244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254,
}


@dataclass
class SnmpDiscoveryResult:
    scanned: int = 0
    found: int = 0
    created: int = 0
    updated: int = 0
    errors: int = 0
    duration_ms: int = 0
    networks: list[str] = field(default_factory=list)
    scope_reasons: list[str] = field(default_factory=list)
    message: str = ""


def local_snmp_networks() -> list[ipaddress.IPv4Network]:
    nets, _reasons = resolve_lan_scan_networks(max_subnets=_MAX_SUBNETS)
    return nets


def _prioritize_printer_ips(ips: list[str], *, hot: set[str]) -> list[str]:
    def sort_key(ip: str) -> tuple[int, int, int]:
        try:
            addr = ipaddress.IPv4Address(ip)
        except ValueError:
            return (9, 0, 0)
        last = int(addr) & 0xFF
        if ip in hot:
            return (0, last, int(addr))
        if last in _PRINTER_OFFSETS:
            return (1, last, int(addr))
        return (2, last, int(addr))

    return sorted(ips, key=sort_key)


def _printer_name_from_model(model: str | None, ip: str) -> str:
    if not model:
        return f"SNMP printer {ip}"
    first = model.splitlines()[0].strip()
    if not first:
        return f"SNMP printer {ip}"
    return first[:160]


async def _inventory_hint_ips(db: AsyncSession) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()

    def add(raw: str | None) -> None:
        host = (raw or "").strip().split("/")[0].split(":")[0]
        addr = _private_ipv4(host) if host else None
        if not addr or _is_likely_container_bridge(addr):
            return
        ip = str(addr)
        if ip not in seen:
            seen.add(ip)
            found.append(ip)

    pc_rows = (
        await db.execute(
            select(Computer.ip_address, Computer.raw_payload, Computer.mac_primary)
        )
    ).all()
    for ip_col, raw, mac in pc_rows:
        add(str(ip_col) if ip_col else None)
        if not ip_col:
            add(
                primary_ipv4_from_raw_payload(
                    raw,
                    prefer_mac=str(mac).strip() if mac else None,
                )
            )
    for (ip,) in (await db.execute(select(Printer.ip_address))).all():
        add(ip)
    for (ip,) in (await db.execute(select(NetworkDevice.ip_address))).all():
        add(ip)
    return found


def _expand_hosts(networks: list[ipaddress.IPv4Network]) -> tuple[list[str], bool]:
    ips: list[str] = []
    truncated = False
    seen: set[str] = set()
    for net in networks:
        hosts = list(net.hosts())
        if len(hosts) > _MAX_HOSTS_PER_NETWORK:
            hosts = hosts[:_MAX_HOSTS_PER_NETWORK]
            truncated = True
        for ip in hosts:
            s = str(ip)
            if s in seen:
                continue
            seen.add(s)
            ips.append(s)
            if len(ips) >= _MAX_DISCOVERY_IPS:
                return ips, True
    return ips, truncated


async def discover_snmp_printers(
    db: AsyncSession,
    *,
    community: str = "public",
    communities: list[str] | None = None,
    timeout: float = 1.2,
    total_budget_seconds: float = 90.0,
    concurrency: int = 16,
    cidr_list: list[str] | None = None,
) -> SnmpDiscoveryResult:
    started = time.monotonic()
    deadline = started + max(15.0, total_budget_seconds)
    result = SnmpDiscoveryResult()

    hint_ips = await _inventory_hint_ips(db)
    networks, reasons = resolve_lan_scan_networks(
        cidr_list=cidr_list,
        hint_ips=hint_ips,
        max_subnets=_MAX_SUBNETS,
    )
    result.networks = [str(n) for n in networks]
    result.scope_reasons = reasons

    if not networks:
        result.message = (
            reasons[-1]
            if reasons
            else "Не удалось определить LAN для SNMP discovery (контейнер не видит подсеть хоста)."
        )
        result.duration_ms = int((time.monotonic() - started) * 1000)
        return result

    unique_ips, truncated_networks = _expand_hosts(networks)
    hot = set(hint_ips)
    unique_ips = _prioritize_printer_ips(unique_ips, hot=hot)

    workers = max(1, min(concurrency, _DEFAULT_DISCOVERY_CONCURRENCY if _WIN32 else 48))
    try_comms = []
    for c in [community, *(communities or [])]:
        c = (c or "").strip()
        if c and c not in try_comms:
            try_comms.append(c)
    if not try_comms:
        try_comms = ["public"]

    found: list[tuple[str, str | None, str]] = []
    found_ips: set[str] = set()

    async def probe(ip: str) -> None:
        if time.monotonic() >= deadline:
            return
        result.scanned += 1
        snap = None
        for comm in try_comms:
            snap = await probe_printer_snmp(ip, community=comm, timeout=timeout)
            if snap.model and not snap.error:
                break
        if snap is None:
            return
        if snap.model:
            if is_network_gear_text(snap.model, snap.sys_name):
                return
            found.append((ip, snap.model, snap.printer_kind or "unknown"))
            found_ips.add(ip)
        elif snap.error:
            result.errors += 1

    await run_async_pool(unique_ips, probe, workers)

    now = datetime.now(timezone.utc)
    for ip, model, kind in found:
        dedupe_key = printer_dedupe_key_for_ip(ip)
        existing = (
            await db.execute(
                select(Printer).where((Printer.ip_address == ip) | (Printer.dedupe_key == dedupe_key)).limit(1)
            )
        ).scalar_one_or_none()
        if existing is None:
            row = Printer(
                dedupe_key=dedupe_key,
                name=_printer_name_from_model(model, ip),
                ip_address=ip,
                is_network=True,
                source="snmp",
                poll_status="online",
                snmp_status="ok",
                snmp_model=model,
                printer_kind=kind,
                last_seen_at=now,
                last_poll_at=now,
                last_snmp_at=now,
            )
            db.add(row)
            result.created += 1
        else:
            existing.dedupe_key = dedupe_key
            existing.ip_address = ip
            existing.is_network = True
            existing.poll_status = "online"
            existing.snmp_status = "ok"
            existing.snmp_error = None
            existing.snmp_model = model or existing.snmp_model
            if kind and kind != "unknown":
                existing.printer_kind = kind
            # Не трогаем existing.name — пользовательское имя сохраняется.
            existing.last_seen_at = now
            existing.last_poll_at = now
            existing.last_snmp_at = now
            result.updated += 1

    result.found = len(found)
    await db.commit()
    result.duration_ms = int((time.monotonic() - started) * 1000)
    zone = ", ".join(result.networks[:8])
    limit_note = " (сканирование ограничено по числу адресов)" if truncated_networks else ""
    why = f" Зона: {'; '.join(reasons[:3])}." if reasons else ""
    if result.found:
        result.message = (
            f"SNMP discovery: просканировано {result.scanned} адресов ({zone}), "
            f"найдено {result.found}, добавлено {result.created}, обновлено {result.updated}."
            f"{limit_note}{why}"
        )
    else:
        result.message = (
            f"SNMP discovery: за {result.duration_ms} мс просканировано {result.scanned} адресов "
            f"({zone}), принтеры по UDP/161 не ответили. "
            f"Проверьте community/SNMP v2c и что зона — LAN, а не Docker 172.x."
            f"{limit_note}{why}"
        )
    return result
