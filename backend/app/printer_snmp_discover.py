from __future__ import annotations

import ipaddress
import platform
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.async_pool import run_async_pool
from app.local_ip import local_ipv4_addresses
from app.models import Printer
from app.printer_cleanup import printer_dedupe_key_for_ip
from app.printer_snmp import probe_printer_snmp

# Full /24 scan × several NICs can spawn 500+ SNMP sockets and hit Windows select() limits.
_MAX_HOSTS_PER_NETWORK = 128
_MAX_DISCOVERY_IPS = 256
_WIN32 = platform.system().lower() == "windows"
_DEFAULT_DISCOVERY_CONCURRENCY = 6 if _WIN32 else 16


@dataclass
class SnmpDiscoveryResult:
    scanned: int = 0
    found: int = 0
    created: int = 0
    updated: int = 0
    errors: int = 0
    duration_ms: int = 0
    networks: list[str] = field(default_factory=list)
    message: str = ""


_NON_PRINTER_RE = re.compile(
    r"\bswitch\b|officeconnect|superstack|router|firewall|access\s+point|wireless\s+controller|mikrotik|ubiquiti|cisco",
    re.I,
)


def local_snmp_networks() -> list[ipaddress.IPv4Network]:
    networks: set[ipaddress.IPv4Network] = set()
    for addr in local_ipv4_addresses():
        networks.add(ipaddress.ip_network(f"{addr}/24", strict=False))
    return sorted(networks, key=lambda n: int(n.network_address))


def _printer_name_from_model(model: str | None, ip: str) -> str:
    if not model:
        return f"SNMP printer {ip}"
    first = model.splitlines()[0].strip()
    if not first:
        return f"SNMP printer {ip}"
    return first[:160]


async def discover_snmp_printers(
    db: AsyncSession,
    *,
    community: str = "public",
    timeout: float = 1.2,
    total_budget_seconds: float = 30.0,
    concurrency: int = 16,
) -> SnmpDiscoveryResult:
    started = time.monotonic()
    deadline = started + max(5.0, total_budget_seconds)
    result = SnmpDiscoveryResult()
    networks = local_snmp_networks()
    result.networks = [str(n) for n in networks]

    if not networks:
        result.message = "Не удалось определить локальные IPv4-подсети сервера для SNMP discovery."
        return result

    ips: list[str] = []
    truncated_networks = False
    for net in networks:
        hosts = list(net.hosts())
        if len(hosts) > _MAX_HOSTS_PER_NETWORK:
            hosts = hosts[:_MAX_HOSTS_PER_NETWORK]
            truncated_networks = True
        ips.extend(str(ip) for ip in hosts)

    seen: set[str] = set()
    unique_ips: list[str] = []
    for ip in ips:
        if ip not in seen:
            seen.add(ip)
            unique_ips.append(ip)
    if len(unique_ips) > _MAX_DISCOVERY_IPS:
        unique_ips = unique_ips[:_MAX_DISCOVERY_IPS]
        truncated_networks = True

    workers = max(1, min(concurrency, _DEFAULT_DISCOVERY_CONCURRENCY if _WIN32 else 24))
    found: list[tuple[str, str | None]] = []

    async def probe(ip: str) -> None:
        if time.monotonic() >= deadline:
            return
        result.scanned += 1
        snap = await probe_printer_snmp(ip, community=community, timeout=timeout)
        if snap.model:
            if _NON_PRINTER_RE.search(snap.model):
                return
            found.append((ip, snap.model))
        elif snap.error:
            result.errors += 1

    await run_async_pool(unique_ips, probe, workers)

    now = datetime.now(timezone.utc)
    for ip, model in found:
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
            existing.last_seen_at = now
            existing.last_poll_at = now
            existing.last_snmp_at = now
            result.updated += 1

    result.found = len(found)
    await db.commit()
    result.duration_ms = int((time.monotonic() - started) * 1000)
    limit_note = " (сканирование ограничено по числу адресов)" if truncated_networks else ""
    if result.found:
        result.message = (
            f"SNMP discovery: просканировано {result.scanned} адресов ({', '.join(result.networks)}), "
            f"найдено {result.found}, добавлено {result.created}, обновлено {result.updated}.{limit_note}"
        )
    else:
        result.message = (
            f"SNMP discovery: за {result.duration_ms} мс просканировано {result.scanned} адресов "
            f"({', '.join(result.networks)}), ответов UDP/161 нет. Проверьте VLAN/фаервол/community/SNMP v2c.{limit_note}"
        )
    return result
