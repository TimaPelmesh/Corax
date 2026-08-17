from __future__ import annotations

import asyncio
import ipaddress
import json
import platform
import re
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.local_ip import discover_corax_network_scope, local_ipv4_networks
from app.models import Computer, NetworkDevice
from app.network_classify import network_dedupe_key_for_ip
from app.observability import get_logger

log = get_logger("corax.network_tracer")

_WIN32 = platform.system().lower() == "windows"
_HOP_LINE_RE = re.compile(r"^\s*\d+\s+(.+)$")
_IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_RTT_RE = re.compile(r"<?(\d+(?:[.,]\d+)?)\s*ms", re.I)
_GATEWAY_TYPES = frozenset({"router", "gateway", "firewall", "modem"})
_CORE_TYPES = frozenset({"router", "gateway", "firewall", "switch", "controller", "modem"})


@dataclass(frozen=True)
class TraceHop:
    ip: str
    rtt_ms: float | None = None

    def to_dict(self) -> dict[str, str | float | None]:
        return {"ip": self.ip, "rtt_ms": self.rtt_ms}


@dataclass(frozen=True)
class TraceRoute:
    target_ip: str
    hops: tuple[TraceHop, ...] = ()
    error: str | None = None


@dataclass
class TraceDiscoveryResult:
    targets: int = 0
    completed: int = 0
    routes: int = 0
    gateway_hops: int = 0
    gateways_created: int = 0
    gateways_updated: int = 0
    skipped_reason: str | None = None
    errors: list[str] = field(default_factory=list)


def _valid_hop_ip(raw: str) -> str | None:
    try:
        addr = ipaddress.ip_address(raw)
    except ValueError:
        return None
    if (
        addr.version != 4
        or not (addr.is_private or addr.is_link_local)
        or addr.is_loopback
        or addr.is_multicast
        or addr.is_unspecified
        or addr.is_reserved
    ):
        return None
    return str(addr)


def parse_trace_output(output: str, target_ip: str) -> tuple[TraceHop, ...]:
    """Parse numeric Windows tracert or Linux traceroute output."""
    hops: list[TraceHop] = []
    for line in output.splitlines():
        match = _HOP_LINE_RE.match(line)
        if not match:
            continue
        body = match.group(1)
        ips = _IP_RE.findall(body)
        if not ips:
            continue
        ip = _valid_hop_ip(ips[-1])
        if ip is None:
            continue
        rtt_match = _RTT_RE.search(body)
        rtt_ms = float(rtt_match.group(1).replace(",", ".")) if rtt_match else None
        hop = TraceHop(ip=ip, rtt_ms=rtt_ms)
        if not hops or hops[-1].ip != hop.ip:
            hops.append(hop)
        if ip == target_ip:
            break
    return tuple(hops)


def _trace_command(target_ip: str, *, max_hops: int, timeout_ms: int) -> list[str] | None:
    if _WIN32:
        binary = shutil.which("tracert")
        if not binary:
            return None
        return [binary, "-d", "-h", str(max_hops), "-w", str(timeout_ms), target_ip]

    binary = shutil.which("traceroute")
    if not binary:
        return None
    timeout_seconds = max(1, int((timeout_ms + 999) / 1000))
    return [
        binary,
        "-n",
        "-m",
        str(max_hops),
        "-w",
        str(timeout_seconds),
        "-q",
        "1",
        target_ip,
    ]


async def trace_route(
    target_ip: str,
    *,
    max_hops: int = 18,
    timeout_ms: int = 700,
    process_timeout_seconds: float = 28.0,
) -> TraceRoute:
    command = _trace_command(target_ip, max_hops=max_hops, timeout_ms=timeout_ms)
    if command is None:
        return TraceRoute(target_ip=target_ip, error="traceroute command is unavailable")
    try:
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=process_timeout_seconds)
    except TimeoutError:
        if "proc" in locals() and proc.returncode is None:
            proc.kill()
            await proc.communicate()
        return TraceRoute(target_ip=target_ip, error="traceroute timeout")
    except OSError as exc:
        return TraceRoute(target_ip=target_ip, error=str(exc)[:160])

    output = stdout.decode(errors="replace")
    hops = parse_trace_output(output, target_ip)
    if not hops:
        return TraceRoute(target_ip=target_ip, error="no responsive hops")
    return TraceRoute(target_ip=target_ip, hops=hops)


def _slash24(ip: str | None) -> ipaddress.IPv4Network | None:
    try:
        addr = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return None
    if addr.version != 4 or not addr.is_private or addr.is_loopback:
        return None
    return ipaddress.ip_network(f"{addr}/24", strict=False)


def _probe_ips_for_network(network: ipaddress.IPv4Network) -> list[str]:
    """Typical gateway addresses on a /24 (.1 and .254)."""
    out: list[str] = []
    base = int(network.network_address)
    for offset in (1, 254):
        try:
            addr = ipaddress.IPv4Address(base + offset)
        except ipaddress.AddressValueError:
            continue
        if addr in network:
            out.append(str(addr))
    return out


def collect_trace_target_ips(
    device_ips: list[tuple[str, str, str]],
    *,
    neighbor_networks: list[str] | tuple[str, ...] = (),
    gateway_ips: list[str] | tuple[str, ...] = (),
    computer_ips: list[str] | tuple[str, ...] = (),
    local_networks: list[ipaddress.IPv4Network] | tuple[ipaddress.IPv4Network, ...] | None = None,
    max_targets: int = 64,
) -> list[str]:
    """
    Build traceroute destinations: known gateways, one probe per /24,
    then neighbor-subnet .1/.254 when no router is inventoried there.
    """
    local = tuple(local_networks) if local_networks is not None else tuple(local_ipv4_networks())
    by_network: dict[ipaddress.IPv4Network, list[tuple[int, int, str]]] = {}
    computers_by_net: dict[ipaddress.IPv4Network, list[str]] = {}
    networks: set[ipaddress.IPv4Network] = set()

    def remember_net(network: ipaddress.IPv4Network | None) -> None:
        if network is not None:
            networks.add(network)

    for ip, device_type, source in device_ips:
        network = _slash24(ip)
        if network is None:
            continue
        remember_net(network)
        dtype = (device_type or "").lower()
        rank = (
            0 if dtype in _GATEWAY_TYPES else 1 if dtype in _CORE_TYPES else 2,
            1 if (source or "") == "trace" else 0,
            ip,
        )
        by_network.setdefault(network, []).append(rank)

    for raw in computer_ips:
        network = _slash24(raw)
        if network is None:
            continue
        remember_net(network)
        computers_by_net.setdefault(network, []).append(raw.strip())

    for raw in neighbor_networks:
        try:
            network = ipaddress.ip_network(str(raw), strict=False)
        except ValueError:
            continue
        if network.version != 4:
            continue
        unit = network if network.prefixlen >= 24 else ipaddress.ip_network(f"{network.network_address}/24")
        if unit.prefixlen > 24:
            unit = ipaddress.ip_network(f"{network.network_address}/24", strict=False)
        remember_net(unit)

    for raw in gateway_ips:
        remember_net(_slash24(raw))

    def net_sort(network: ipaddress.IPv4Network) -> tuple[int, int]:
        is_local = any(network.overlaps(local_net) for local_net in local)
        return (1 if is_local else 0, int(network.network_address))

    seen: set[str] = set()
    targets: list[str] = []

    def add(ip: str | None) -> bool:
        if not ip or ip in seen:
            return False
        if _valid_hop_ip(ip) is None:
            return False
        seen.add(ip)
        targets.append(ip)
        return True

    for gw in gateway_ips:
        add(gw)
        if len(targets) >= max_targets:
            return targets

    leftover_probes: list[str] = []
    for network in sorted(networks, key=net_sort):
        if len(targets) >= max_targets:
            break
        rows = sorted(by_network.get(network, []))
        if rows:
            add(rows[0][2])
            dtype_rank = rows[0][0]
            if dtype_rank > 0:
                leftover_probes.extend(_probe_ips_for_network(network))
            continue
        probes = _probe_ips_for_network(network)
        added = False
        for probe in probes:
            if add(probe):
                added = True
                break
        if not added:
            comps = computers_by_net.get(network) or []
            if comps:
                add(comps[0])
        leftover_probes.extend(probes[1:])

    for ip in leftover_probes:
        if len(targets) >= max_targets:
            break
        add(ip)

    if len(targets) < max_targets:
        for comps in computers_by_net.values():
            if len(targets) >= max_targets:
                break
            if comps:
                add(comps[0])

    return targets[:max_targets]


def _trace_targets(devices: list[NetworkDevice], *, max_targets: int) -> list[NetworkDevice]:
    """Pick one stable target per /24; remote networks first."""
    ips = collect_trace_target_ips(
        [(d.ip_address or "", d.device_type or "", d.source or "") for d in devices],
        max_targets=max_targets,
    )
    by_ip = { (d.ip_address or "").strip(): d for d in devices if d.ip_address }
    return [by_ip[ip] for ip in ips if ip in by_ip]


def _read_extras(device: NetworkDevice) -> dict:
    try:
        value = json.loads(device.extras_json or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _looks_like_gateway_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    last = int(addr) & 0xFF
    return last in {1, 254}


async def _ensure_trace_device(
    db: AsyncSession,
    by_ip: dict[str, NetworkDevice],
    ip: str,
    *,
    now: datetime,
    now_iso: str,
    as_gateway: bool,
) -> tuple[NetworkDevice, bool]:
    existing = by_ip.get(ip)
    if existing is not None:
        return existing, False
    device = NetworkDevice(
        dedupe_key=network_dedupe_key_for_ip(ip),
        ip_address=ip,
        hostname=f"{'Gateway' if as_gateway else 'Host'} {ip}",
        device_type="router" if as_gateway else "host",
        snmp_status="unknown",
        source="trace",
        last_seen_at=now,
        extras_json=json.dumps(
            {"trace_gateway": as_gateway, "trace_seen_at": now_iso},
            ensure_ascii=False,
        ),
    )
    db.add(device)
    await db.flush()
    by_ip[ip] = device
    return device, True


async def trace_nearest_gateways(
    db: AsyncSession,
    *,
    max_targets: int = 64,
    concurrency: int = 8,
) -> TraceDiscoveryResult:
    """
    Trace destinations across local and neighboring /24s and persist observed
    gateway chains. This is L3 evidence and never replaces LLDP/CDP/FDB links.
    """
    result = TraceDiscoveryResult()
    if _trace_command("127.0.0.1", max_hops=1, timeout_ms=100) is None:
        result.skipped_reason = "traceroute command is unavailable"
        return result

    devices = (await db.execute(select(NetworkDevice).order_by(NetworkDevice.id.asc()))).scalars().all()
    computers = (
        await db.execute(
            select(Computer.ip_address).where(Computer.ip_address.is_not(None)).limit(400)
        )
    ).all()
    scope = discover_corax_network_scope(max_subnets=64)
    target_ips = collect_trace_target_ips(
        [(d.ip_address or "", d.device_type or "", d.source or "") for d in devices],
        neighbor_networks=[str(n) for n in scope.networks],
        gateway_ips=list(scope.gateways),
        computer_ips=[row[0] for row in computers if row[0]],
        max_targets=max_targets,
    )
    result.targets = len(target_ips)
    if not target_ips:
        result.skipped_reason = "no trace targets"
        return result

    semaphore = asyncio.Semaphore(max(1, min(concurrency, 10)))
    routes: list[TraceRoute] = []

    async def one(ip: str) -> None:
        async with semaphore:
            routes.append(await trace_route(ip))

    await asyncio.gather(*(one(ip) for ip in target_ips))
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat().replace("+00:00", "Z")
    by_ip = {device.ip_address.strip(): device for device in devices if device.ip_address}

    for route in routes:
        result.completed += 1
        if route.error:
            if len(result.errors) < 8:
                result.errors.append(f"{route.target_ip}: {route.error}")
            continue

        result.routes += 1
        hop_devices: list[NetworkDevice] = []
        for hop in route.hops:
            if hop.ip == route.target_ip:
                continue
            result.gateway_hops += 1
            gateway, created = await _ensure_trace_device(
                db,
                by_ip,
                hop.ip,
                now=now,
                now_iso=now_iso,
                as_gateway=True,
            )
            hop_devices.append(gateway)
            if created:
                result.gateways_created += 1
                continue
            gateway_extras = _read_extras(gateway)
            gateway_extras["trace_gateway"] = True
            gateway_extras["trace_seen_at"] = now_iso
            gateway.extras_json = json.dumps(gateway_extras, ensure_ascii=False)
            gateway.last_seen_at = now
            if gateway.source == "trace" and gateway.device_type in {"unknown", "host"}:
                gateway.device_type = "router"
                gateway.hostname = gateway.hostname or f"Gateway {hop.ip}"
            result.gateways_updated += 1

        target = by_ip.get(route.target_ip)
        if target is None and _looks_like_gateway_ip(route.target_ip):
            target, created_target = await _ensure_trace_device(
                db,
                by_ip,
                route.target_ip,
                now=now,
                now_iso=now_iso,
                as_gateway=True,
            )
            if created_target:
                result.gateways_created += 1
        store_on = target or (hop_devices[-1] if hop_devices else None)
        if store_on is not None:
            extras = _read_extras(store_on)
            payload = {
                "target_ip": route.target_ip,
                "measured_at": now_iso,
                "hops": [hop.to_dict() for hop in route.hops],
            }
            extras["trace_route"] = payload
            traces = extras.get("trace_routes")
            if not isinstance(traces, list):
                traces = []
            traces = [item for item in traces if isinstance(item, dict) and item.get("target_ip") != route.target_ip]
            traces.append(payload)
            extras["trace_routes"] = traces[-12:]
            store_on.extras_json = json.dumps(extras, ensure_ascii=False)
            store_on.last_seen_at = now

    await db.commit()
    log.info(
        "trace complete targets=%s routes=%s hops=%s gateways_created=%s",
        result.targets,
        result.routes,
        result.gateway_hops,
        result.gateways_created,
    )
    return result
