from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import NetworkDevice
from app.network_classify import network_dedupe_key_for_ip


def _merge_extras(row: NetworkDevice, patch: dict[str, Any]) -> None:
    try:
        prev = json.loads(row.extras_json) if row.extras_json else {}
    except (TypeError, json.JSONDecodeError):
        prev = {}
    if not isinstance(prev, dict):
        prev = {}
    prev.update(patch)
    row.extras_json = json.dumps(prev, ensure_ascii=False)


def _host_keys(row: NetworkDevice) -> set[str]:
    out: set[str] = set()
    for raw in (row.hostname, row.sys_name):
        s = (raw or "").strip().lower()
        if not s:
            continue
        out.add(s)
        out.add(s.split(".", 1)[0])
        if " · " in s:
            out.add(s.split(" · ", 1)[-1])
    return out


def match_zabbix_device(
    ip: str,
    host: str,
    name: str,
    by_ip: dict[str, NetworkDevice],
    by_name: dict[str, NetworkDevice],
) -> NetworkDevice | None:
    """Совпадение по IP. Чужое имя с другим адресом не прячет новый хост."""
    if ip:
        return by_ip.get(ip)
    keys = {host.lower(), name.lower(), host.lower().split(".", 1)[0], name.lower().split(".", 1)[0]}
    keys.discard("")
    for key in keys:
        row = by_name.get(key)
        if row is not None:
            return row
    return None


async def merge_zabbix_into_network_devices(db: AsyncSession, *, limit: int = 5000) -> dict[str, int]:
    """
    Pull Zabbix hosts into the Network tab: enrich matching devices, create stubs
    for hosts that SNMP has not seen yet. Never overwrites SNMP identity.
    """
    stats = {"matched": 0, "created": 0, "skipped": 0}
    try:
        from app.zabbix_service import get_hosts_payload
    except Exception:
        return stats
    payload = await get_hosts_payload(db, limit=limit)
    if not payload.get("available"):
        return stats
    items = payload.get("items") or []
    if not isinstance(items, list) or not items:
        return stats

    devices = (await db.execute(select(NetworkDevice))).scalars().all()
    by_ip: dict[str, NetworkDevice] = {}
    by_name: dict[str, NetworkDevice] = {}
    for row in devices:
        if row.ip_address:
            by_ip[row.ip_address.strip()] = row
        for key in _host_keys(row):
            by_name.setdefault(key, row)

    now = datetime.now(timezone.utc)
    for item in items:
        if not isinstance(item, dict):
            stats["skipped"] += 1
            continue
        ip = str(item.get("ip") or "").strip()
        host = str(item.get("host") or "").strip()
        name = str(item.get("name") or host).strip()
        hostid = str(item.get("hostid") or "").strip()
        if not hostid:
            stats["skipped"] += 1
            continue
        zb = {
            "hostid": hostid,
            "host": host,
            "name": name,
            "status": item.get("status"),
            "ip": ip or None,
        }
        row = match_zabbix_device(ip, host, name, by_ip, by_name)
        if row is not None:
            _merge_extras(row, {"zabbix": zb})
            if not row.hostname and name:
                row.hostname = name[:255]
            stats["matched"] += 1
            continue
        if not ip:
            stats["skipped"] += 1
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
            _merge_extras(existing, {"zabbix": zb})
            stats["matched"] += 1
            continue
        created = NetworkDevice(
            dedupe_key=dedupe,
            ip_address=ip,
            hostname=(name or host or f"zabbix {ip}")[:255],
            device_type="unknown",
            snmp_status="n/a",
            source="zabbix",
            last_seen_at=now,
            extras_json=json.dumps({"zabbix": zb}, ensure_ascii=False),
        )
        db.add(created)
        by_ip[ip] = created
        for key in _host_keys(created):
            by_name.setdefault(key, created)
        stats["created"] += 1

    await db.commit()
    return stats
