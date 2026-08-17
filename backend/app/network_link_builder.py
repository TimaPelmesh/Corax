from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass, field

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Computer, NetworkDevice, NetworkLink, Printer
from app.network_classify import normalize_mac

_MAC_RE = re.compile(r"(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}|[0-9a-f]{12}", re.I)

# Prefer these as logical parents when attaching orphans on the same /24.
_CORE_TYPES = frozenset({"switch", "router", "gateway", "firewall", "controller", "ap"})


@dataclass
class LinkBuildResult:
    device_links: int = 0
    computer_links: int = 0
    printer_links: int = 0
    trace_links: int = 0
    logical_links: int = 0
    cleared: int = 0
    message: str = ""


@dataclass
class _HostIndex:
    by_hostname: dict[str, tuple[str, int]] = field(default_factory=dict)
    by_ip: dict[str, tuple[str, int]] = field(default_factory=dict)
    by_mac: dict[str, tuple[str, int]] = field(default_factory=dict)
    # network_device id -> (ip, device_type, hostname)
    devices_meta: dict[int, tuple[str | None, str | None, str | None]] = field(default_factory=dict)


def _macs_from_interfaces_json(raw: str | None) -> set[str]:
    out: set[str] = set()
    if not raw:
        return out
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return out
    rows = data if isinstance(data, list) else []
    for iface in rows:
        if not isinstance(iface, dict):
            continue
        mac = normalize_mac(iface.get("mac"))
        if mac:
            out.add(mac)
    return out


def _extract_macs_from_payload(raw: str | None) -> set[str]:
    out: set[str] = set()
    if not raw:
        return out
    for m in _MAC_RE.finditer(raw):
        mac = normalize_mac(m.group(0))
        if mac:
            out.add(mac)
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return out
    stack: list[object] = [data]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            for k, v in cur.items():
                if isinstance(k, str) and "mac" in k.lower() and isinstance(v, str):
                    mac = normalize_mac(v)
                    if mac:
                        out.add(mac)
                stack.append(v)
        elif isinstance(cur, list):
            stack.extend(cur)
    return out


def _extract_ips_from_payload(raw: str | None) -> set[str]:
    out: set[str] = set()
    if not raw:
        return out
    for m in re.finditer(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", raw):
        ip = m.group(0)
        parts = ip.split(".")
        try:
            if all(0 <= int(p) <= 255 for p in parts):
                if not ip.startswith("127.") and not ip.startswith("255."):
                    out.add(ip)
        except ValueError:
            continue
    return out


def _subnet24(ip: str | None) -> str | None:
    if not ip:
        return None
    try:
        addr = ipaddress.ip_address(ip.strip())
        if addr.version != 4 or addr.is_loopback or addr.is_multicast:
            return None
        net = ipaddress.ip_network(f"{addr}/24", strict=False)
        return str(net)
    except ValueError:
        return None


async def build_host_index(db: AsyncSession) -> _HostIndex:
    idx = _HostIndex()
    devices = (await db.execute(select(NetworkDevice))).scalars().all()
    for d in devices:
        idx.by_hostname[(d.hostname or "").strip().lower()] = ("network_device", d.id)
        if d.sys_name:
            idx.by_hostname[d.sys_name.strip().lower()] = ("network_device", d.id)
        if d.ip_address:
            idx.by_ip[d.ip_address.strip()] = ("network_device", d.id)
        idx.devices_meta[d.id] = (d.ip_address, d.device_type, d.hostname)
        for mac in _macs_from_interfaces_json(d.interfaces_json):
            idx.by_mac[mac] = ("network_device", d.id)
        # MAC of network gear from extras / FDB own ports is rare; still index sys_name short
        if d.hostname and "." in d.hostname:
            idx.by_hostname[d.hostname.split(".")[0].strip().lower()] = ("network_device", d.id)

    computers = (await db.execute(select(Computer))).scalars().all()
    for c in computers:
        if c.hostname:
            idx.by_hostname[c.hostname.strip().lower()] = ("computer", c.id)
            if "." in c.hostname:
                idx.by_hostname[c.hostname.split(".")[0].strip().lower()] = ("computer", c.id)
        mac = normalize_mac(c.mac_primary)
        if mac:
            idx.by_mac.setdefault(mac, ("computer", c.id))
        for mac2 in _extract_macs_from_payload(c.raw_payload):
            idx.by_mac.setdefault(mac2, ("computer", c.id))
        if c.ip_address:
            idx.by_ip.setdefault(c.ip_address.strip(), ("computer", c.id))
        for ip in _extract_ips_from_payload(c.raw_payload):
            idx.by_ip.setdefault(ip, ("computer", c.id))

    printers = (await db.execute(select(Printer).where(Printer.ip_address.is_not(None)))).scalars().all()
    for p in printers:
        if p.ip_address:
            idx.by_ip[p.ip_address.strip()] = ("printer", p.id)
        if p.name:
            idx.by_hostname[p.name.strip().lower()] = ("printer", p.id)
    return idx


async def upsert_link(
    db: AsyncSession,
    *,
    from_type: str,
    from_id: int,
    to_type: str,
    to_id: int,
    link_type: str,
    local_port: str | None = None,
    remote_port: str | None = None,
    confidence: float = 1.0,
) -> bool:
    if from_type == to_type and from_id == to_id:
        return False
    if from_type == to_type == "network_device" and from_id > to_id:
        from_type, to_type = to_type, from_type
        from_id, to_id = to_id, from_id
        local_port, remote_port = remote_port, local_port

    existing = (
        await db.execute(
            select(NetworkLink).where(
                NetworkLink.from_type == from_type,
                NetworkLink.from_id == from_id,
                NetworkLink.to_type == to_type,
                NetworkLink.to_id == to_id,
                NetworkLink.link_type == link_type,
            ).limit(1)
        )
    ).scalar_one_or_none()
    if existing:
        existing.local_port = local_port or existing.local_port
        existing.remote_port = remote_port or existing.remote_port
        existing.confidence = max(float(existing.confidence or 0), confidence)
        return False
    db.add(
        NetworkLink(
            from_type=from_type,
            from_id=from_id,
            to_type=to_type,
            to_id=to_id,
            link_type=link_type,
            local_port=local_port,
            remote_port=remote_port,
            confidence=confidence,
        )
    )
    return True


def _resolve_neighbor_target(idx: _HostIndex, remote_ip: str | None, remote_name: str | None) -> tuple[str, int] | None:
    if remote_ip and remote_ip in idx.by_ip:
        return idx.by_ip[remote_ip]
    if remote_name:
        low = remote_name.strip().lower()
        if low in idx.by_hostname:
            return idx.by_hostname[low]
        if "." in low:
            short = low.split(".")[0]
            if short in idx.by_hostname:
                return idx.by_hostname[short]
        # Chassis ID sometimes looks like a MAC
        mac = normalize_mac(remote_name)
        if mac and mac in idx.by_mac:
            return idx.by_mac[mac]
    return None


async def rebuild_links_for_device(
    db: AsyncSession,
    device: NetworkDevice,
    idx: _HostIndex,
    *,
    clear_auto: bool = True,
) -> LinkBuildResult:
    result = LinkBuildResult()
    if clear_auto:
        q = await db.execute(
            delete(NetworkLink).where(
                NetworkLink.link_type.in_(("lldp", "cdp", "fdb", "trace", "subnet")),
                or_(
                    (NetworkLink.from_type == "network_device") & (NetworkLink.from_id == device.id),
                    (NetworkLink.to_type == "network_device") & (NetworkLink.to_id == device.id),
                ),
            )
        )
        result.cleared = q.rowcount or 0

    neighbors: list[dict] = []
    if device.neighbors_json:
        try:
            neighbors = json.loads(device.neighbors_json) or []
        except json.JSONDecodeError:
            neighbors = []

    for n in neighbors:
        if not isinstance(n, dict):
            continue
        protocol = str(n.get("protocol") or "lldp")
        remote_ip = (n.get("remote_ip") or "").strip() or None
        remote_name = (n.get("remote_name") or n.get("remote_chassis") or "").strip() or None
        target = _resolve_neighbor_target(idx, remote_ip, remote_name)
        if not target:
            continue
        to_type, to_id = target
        created = await upsert_link(
            db,
            from_type="network_device",
            from_id=device.id,
            to_type=to_type,
            to_id=to_id,
            link_type=protocol if protocol in ("lldp", "cdp") else "lldp",
            local_port=n.get("local_port"),
            remote_port=n.get("remote_port"),
            confidence=0.9,
        )
        if created:
            if to_type == "network_device":
                result.device_links += 1
            elif to_type == "computer":
                result.computer_links += 1
            elif to_type == "printer":
                result.printer_links += 1

    fdb: list[dict] = []
    if device.fdb_json:
        try:
            fdb = json.loads(device.fdb_json) or []
        except json.JSONDecodeError:
            fdb = []

    seen_mac_targets: set[tuple[str, int]] = set()
    for entry in fdb:
        if not isinstance(entry, dict):
            continue
        mac = normalize_mac(entry.get("mac"))
        if not mac or mac not in idx.by_mac:
            continue
        to_type, to_id = idx.by_mac[mac]
        if to_type == "network_device" and to_id == device.id:
            continue
        key = (to_type, to_id)
        if key in seen_mac_targets:
            continue
        seen_mac_targets.add(key)
        local_port = entry.get("if_index") or entry.get("port")
        if local_port is not None:
            local_port = str(local_port)
        created = await upsert_link(
            db,
            from_type="network_device",
            from_id=device.id,
            to_type=to_type,
            to_id=to_id,
            link_type="fdb",
            local_port=local_port,
            confidence=0.7 if to_type == "network_device" else 0.75,
        )
        if created:
            if to_type == "network_device":
                result.device_links += 1
            elif to_type == "computer":
                result.computer_links += 1
            elif to_type == "printer":
                result.printer_links += 1

    return result


async def seed_trace_links(db: AsyncSession, idx: _HostIndex, devices: list[NetworkDevice]) -> int:
    """Create L3 gateway-chain edges from persisted traceroute evidence."""
    stronger_pairs: set[tuple[int, int]] = set()
    rows = (
        await db.execute(
            select(
                NetworkLink.from_id,
                NetworkLink.to_id,
            ).where(
                NetworkLink.from_type == "network_device",
                NetworkLink.to_type == "network_device",
                NetworkLink.link_type.in_(("lldp", "cdp", "fdb")),
            )
        )
    ).all()
    for from_id, to_id in rows:
        stronger_pairs.add(tuple(sorted((from_id, to_id))))

    created = 0
    for device in devices:
        try:
            extras = json.loads(device.extras_json or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(extras, dict):
            continue
        traces: list[object] = []
        if isinstance(extras.get("trace_routes"), list):
            traces.extend(extras["trace_routes"])
        elif isinstance(extras.get("trace_route"), dict):
            traces.append(extras["trace_route"])
        for trace in traces:
            hops = trace.get("hops") if isinstance(trace, dict) else None
            if not isinstance(hops, list):
                continue

            chain: list[int] = []
            for hop in hops:
                if not isinstance(hop, dict):
                    continue
                ip = str(hop.get("ip") or "").strip()
                target = idx.by_ip.get(ip)
                if not target or target[0] != "network_device":
                    continue
                target_id = target[1]
                if not chain or chain[-1] != target_id:
                    chain.append(target_id)

            for from_id, to_id in zip(chain, chain[1:]):
                pair = tuple(sorted((from_id, to_id)))
                if pair in stronger_pairs:
                    continue
                if await upsert_link(
                    db,
                    from_type="network_device",
                    from_id=from_id,
                    to_type="network_device",
                    to_id=to_id,
                    link_type="trace",
                    confidence=0.62,
                ):
                    created += 1
                    stronger_pairs.add(pair)
    return created


def _core_rank(device_type: str | None, hostname: str | None) -> int:
    dtype = (device_type or "").lower()
    host = (hostname or "").lower()
    if host.startswith("gateway") or dtype == "router":
        return 100
    if dtype == "firewall":
        return 90
    if dtype == "controller":
        return 80
    if dtype == "switch":
        return 70
    if dtype == "ap":
        return 55
    if dtype in _CORE_TYPES:
        return 40
    return 10


async def seed_logical_subnet_links(db: AsyncSession, idx: _HostIndex) -> int:
    """Attach unlinked endpoints to the best core device on the same /24."""
    # Existing endpoints already linked (any auto link)
    linked: set[tuple[str, int]] = set()
    rows = (
        await db.execute(
            select(
                NetworkLink.from_type,
                NetworkLink.from_id,
                NetworkLink.to_type,
                NetworkLink.to_id,
            ).where(NetworkLink.link_type.in_(("lldp", "cdp", "fdb", "trace", "subnet")))
        )
    ).all()
    for ft, fid, tt, tid in rows:
        linked.add((ft, fid))
        linked.add((tt, tid))

    # Core candidates by /24
    cores_by_net: dict[str, list[tuple[int, int]]] = {}  # net -> [(rank, device_id)]
    for did, (ip, dtype, hostname) in idx.devices_meta.items():
        net = _subnet24(ip)
        if not net:
            continue
        rank = _core_rank(dtype, hostname)
        if rank < 40:
            continue
        cores_by_net.setdefault(net, []).append((rank, did))
    for net in cores_by_net:
        cores_by_net[net].sort(reverse=True)

    created = 0
    # Attach network devices that look like leaves (host/ap/voip/unknown) and have no links
    for did, (ip, dtype, _hostname) in idx.devices_meta.items():
        if ("network_device", did) in linked:
            continue
        net = _subnet24(ip)
        if not net or net not in cores_by_net:
            continue
        parent_id = cores_by_net[net][0][1]
        if parent_id == did:
            continue
        # Don't attach core-to-core via weak subnet (avoid mesh clutter)
        if _core_rank(dtype, None) >= 70:
            continue
        ok = await upsert_link(
            db,
            from_type="network_device",
            from_id=parent_id,
            to_type="network_device",
            to_id=did,
            link_type="subnet",
            confidence=0.45,
        )
        if ok:
            created += 1
            linked.add(("network_device", did))

    # Attach computers by IP
    for ip, (typ, oid) in list(idx.by_ip.items()):
        if typ != "computer":
            continue
        if (typ, oid) in linked:
            continue
        net = _subnet24(ip)
        if not net or net not in cores_by_net:
            continue
        parent_id = cores_by_net[net][0][1]
        ok = await upsert_link(
            db,
            from_type="network_device",
            from_id=parent_id,
            to_type="computer",
            to_id=oid,
            link_type="subnet",
            confidence=0.4,
        )
        if ok:
            created += 1
            linked.add((typ, oid))

    # Attach printers
    for ip, (typ, oid) in list(idx.by_ip.items()):
        if typ != "printer":
            continue
        if (typ, oid) in linked:
            continue
        net = _subnet24(ip)
        if not net or net not in cores_by_net:
            continue
        parent_id = cores_by_net[net][0][1]
        ok = await upsert_link(
            db,
            from_type="network_device",
            from_id=parent_id,
            to_type="printer",
            to_id=oid,
            link_type="subnet",
            confidence=0.4,
        )
        if ok:
            created += 1

    return created


async def rebuild_all_links(db: AsyncSession) -> LinkBuildResult:
    idx = await build_host_index(db)
    cleared = await db.execute(
        delete(NetworkLink).where(NetworkLink.link_type.in_(("lldp", "cdp", "fdb", "trace", "subnet")))
    )
    total = LinkBuildResult(cleared=cleared.rowcount or 0)
    devices = (await db.execute(select(NetworkDevice))).scalars().all()
    for d in devices:
        part = await rebuild_links_for_device(db, d, idx, clear_auto=False)
        total.device_links += part.device_links
        total.computer_links += part.computer_links
        total.printer_links += part.printer_links
    total.trace_links = await seed_trace_links(db, idx, list(devices))
    total.device_links += total.trace_links
    total.logical_links = await seed_logical_subnet_links(db, idx)
    await db.commit()
    total.message = (
        f"Связи: устройств {total.device_links}, ПК {total.computer_links}, "
        f"принтеров {total.printer_links}, маршрутов {total.trace_links}, "
        f"логических {total.logical_links} "
        f"(очищено авто {total.cleared})"
    )
    return total
