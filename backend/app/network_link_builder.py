from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Computer, NetworkDevice, NetworkLink, Printer
from app.network_classify import normalize_mac

_MAC_RE = re.compile(r"(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}|[0-9a-f]{12}", re.I)


@dataclass
class LinkBuildResult:
    device_links: int = 0
    computer_links: int = 0
    printer_links: int = 0
    cleared: int = 0
    message: str = ""


@dataclass
class _HostIndex:
    by_hostname: dict[str, tuple[str, int]] = field(default_factory=dict)  # lower name -> (type, id)
    by_ip: dict[str, tuple[str, int]] = field(default_factory=dict)
    by_mac: dict[str, tuple[str, int]] = field(default_factory=dict)


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
                # skip obvious non-host
                if not ip.startswith("127.") and not ip.startswith("255."):
                    out.add(ip)
        except ValueError:
            continue
    return out


async def build_host_index(db: AsyncSession) -> _HostIndex:
    idx = _HostIndex()
    devices = (await db.execute(select(NetworkDevice))).scalars().all()
    for d in devices:
        idx.by_hostname[(d.hostname or "").strip().lower()] = ("network_device", d.id)
        if d.sys_name:
            idx.by_hostname[d.sys_name.strip().lower()] = ("network_device", d.id)
        if d.ip_address:
            idx.by_ip[d.ip_address.strip()] = ("network_device", d.id)

    computers = (await db.execute(select(Computer))).scalars().all()
    for c in computers:
        if c.hostname:
            idx.by_hostname[c.hostname.strip().lower()] = ("computer", c.id)
        mac = normalize_mac(c.mac_primary)
        if mac:
            idx.by_mac[mac] = ("computer", c.id)
        for mac2 in _extract_macs_from_payload(c.raw_payload):
            idx.by_mac.setdefault(mac2, ("computer", c.id))
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
    # Canonical order for device↔device undirected uniqueness (lower id as from when same type)
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
                NetworkLink.link_type.in_(("lldp", "cdp", "fdb")),
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
        remote_name = (n.get("remote_name") or "").strip() or None
        target: tuple[str, int] | None = None
        if remote_ip and remote_ip in idx.by_ip:
            target = idx.by_ip[remote_ip]
        elif remote_name and remote_name.lower() in idx.by_hostname:
            target = idx.by_hostname[remote_name.lower()]
        # Try short hostname (before domain)
        if not target and remote_name and "." in remote_name:
            short = remote_name.split(".")[0].lower()
            target = idx.by_hostname.get(short)
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
        if to_type == "network_device":
            continue  # avoid self/noise
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
            confidence=0.75,
        )
        if created:
            if to_type == "computer":
                result.computer_links += 1
            elif to_type == "printer":
                result.printer_links += 1

    return result


async def rebuild_all_links(db: AsyncSession) -> LinkBuildResult:
    idx = await build_host_index(db)
    # Clear all auto links once, then rebuild without per-device clear
    cleared = await db.execute(delete(NetworkLink).where(NetworkLink.link_type.in_(("lldp", "cdp", "fdb"))))
    total = LinkBuildResult(cleared=cleared.rowcount or 0)
    devices = (await db.execute(select(NetworkDevice))).scalars().all()
    for d in devices:
        part = await rebuild_links_for_device(db, d, idx, clear_auto=False)
        total.device_links += part.device_links
        total.computer_links += part.computer_links
        total.printer_links += part.printer_links
    await db.commit()
    total.message = (
        f"Связи: устройств {total.device_links}, ПК {total.computer_links}, "
        f"принтеров {total.printer_links} (очищено авто {total.cleared})"
    )
    return total
