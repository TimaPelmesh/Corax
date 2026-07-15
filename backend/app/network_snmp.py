from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any

from puresnmp import Client, ObjectIdentifier, V2C

from app.network_classify import build_hints_from_interfaces, classify_device, normalize_mac

OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0"
OID_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"
OID_SYS_UPTIME = "1.3.6.1.2.1.1.3.0"
OID_SYS_CONTACT = "1.3.6.1.2.1.1.4.0"
OID_SYS_NAME = "1.3.6.1.2.1.1.5.0"
OID_SYS_LOCATION = "1.3.6.1.2.1.1.6.0"
OID_SYS_SERVICES = "1.3.6.1.2.1.1.7.0"

# IP-MIB
OID_IP_FORWARDING = "1.3.6.1.2.1.4.1.0"  # 1=forwarding(router), 2=not-forwarding
OID_IP_AD_ENT_ADDR = "1.3.6.1.2.1.4.20.1.1"
OID_IP_NET_TO_MEDIA_PHYS = "1.3.6.1.2.1.4.22.1.2"
OID_IP_NET_TO_MEDIA_NET = "1.3.6.1.2.1.4.22.1.3"

# ENTITY-MIB (physical inventory)
OID_ENT_PHYS_DESCR = "1.3.6.1.2.1.47.1.1.1.1.2"
OID_ENT_PHYS_CLASS = "1.3.6.1.2.1.47.1.1.1.1.5"
OID_ENT_PHYS_NAME = "1.3.6.1.2.1.47.1.1.1.1.7"
OID_ENT_PHYS_SERIAL = "1.3.6.1.2.1.47.1.1.1.1.11"
OID_ENT_PHYS_MODEL = "1.3.6.1.2.1.47.1.1.1.1.13"

# BRIDGE-MIB summary
OID_DOT1D_BASE_NUM_PORTS = "1.3.6.1.2.1.17.1.2.0"

OID_IF_DESCR = "1.3.6.1.2.1.2.2.1.2"
OID_IF_TYPE = "1.3.6.1.2.1.2.2.1.3"
OID_IF_OPER = "1.3.6.1.2.1.2.2.1.8"
OID_IF_SPEED = "1.3.6.1.2.1.2.2.1.5"
OID_IF_PHYS = "1.3.6.1.2.1.2.2.1.6"
OID_IF_NAME = "1.3.6.1.2.1.31.1.1.1.1"

# LLDP remote systems (LLDP-MIB)
OID_LLDP_REM_SYS_NAME = "1.0.8802.1.1.2.1.4.1.1.9"
OID_LLDP_REM_PORT_ID = "1.0.8802.1.1.2.1.4.1.1.7"
OID_LLDP_REM_PORT_DESC = "1.0.8802.1.1.2.1.4.1.1.8"
OID_LLDP_REM_SYS_DESC = "1.0.8802.1.1.2.1.4.1.1.10"

# Cisco CDP cache
OID_CDP_CACHE_DEVICE_ID = "1.3.6.1.4.1.9.9.23.1.2.1.1.6"
OID_CDP_CACHE_DEVICE_PORT = "1.3.6.1.4.1.9.9.23.1.2.1.1.7"
OID_CDP_CACHE_PLATFORM = "1.3.6.1.4.1.9.9.23.1.2.1.1.8"
OID_CDP_CACHE_ADDRESS = "1.3.6.1.4.1.9.9.23.1.2.1.1.4"

# BRIDGE-MIB FDB
OID_DOT1D_TP_FDB_ADDRESS = "1.3.6.1.2.1.17.4.3.1.1"
OID_DOT1D_TP_FDB_PORT = "1.3.6.1.2.1.17.4.3.1.2"
OID_DOT1D_BASE_PORT_IF = "1.3.6.1.2.1.17.1.4.1.2"

_OPER_MAP = {1: "up", 2: "down", 3: "testing", 4: "unknown", 5: "dormant", 6: "notPresent", 7: "lowerLayerDown"}


@dataclass
class SnmpNeighbor:
    protocol: str  # lldp|cdp
    remote_name: str | None = None
    remote_port: str | None = None
    remote_descr: str | None = None
    remote_ip: str | None = None
    local_if_index: str | None = None
    local_port: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol": self.protocol,
            "remote_name": self.remote_name,
            "remote_port": self.remote_port,
            "remote_descr": self.remote_descr,
            "remote_ip": self.remote_ip,
            "local_if_index": self.local_if_index,
            "local_port": self.local_port,
        }


@dataclass
class SnmpInterface:
    if_index: str
    name: str | None = None
    descr: str | None = None
    if_type: int | None = None
    oper_status: str | None = None
    speed: int | None = None
    mac: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "if_index": self.if_index,
            "name": self.name,
            "descr": self.descr,
            "if_type": self.if_type,
            "oper_status": self.oper_status,
            "speed": self.speed,
            "mac": self.mac,
        }


@dataclass
class SnmpFdbEntry:
    mac: str
    port: str | None = None
    if_index: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"mac": self.mac, "port": self.port, "if_index": self.if_index}


@dataclass
class NetworkSnmpSnapshot:
    sys_name: str | None = None
    sys_descr: str | None = None
    sys_object_id: str | None = None
    sys_location: str | None = None
    sys_contact: str | None = None
    sys_uptime_ticks: int | None = None
    sys_uptime_human: str | None = None
    ip_addresses: list[str] = field(default_factory=list)
    device_type: str = "unknown"
    vendor: str | None = None
    model: str | None = None
    serial_number: str | None = None
    classify_confidence: float = 0.0
    classify_signals: list[str] = field(default_factory=list)
    ip_forwarding: bool | None = None
    bridge_num_ports: int | None = None
    is_network_gear: bool = False
    interfaces: list[SnmpInterface] = field(default_factory=list)
    neighbors: list[SnmpNeighbor] = field(default_factory=list)
    fdb: list[SnmpFdbEntry] = field(default_factory=list)
    error: str | None = None


def _uptime_human(ticks: int | None) -> str | None:
    if ticks is None or ticks < 0:
        return None
    # Timeticks are 1/100 second
    sec = ticks // 100
    days, rem = divmod(sec, 86400)
    hours, rem = divmod(rem, 3600)
    mins, secs = divmod(rem, 60)
    if days:
        return f"{days}д {hours}ч {mins}м"
    if hours:
        return f"{hours}ч {mins}м"
    return f"{mins}м {secs}с"


def _oid_to_str(oid: Any) -> str:
    if hasattr(oid, "oid"):
        return str(oid.oid)
    return str(oid)


def _decode_snmp_scalar(raw: Any) -> Any:
    if isinstance(raw, bytes):
        for enc in ("utf-8", "cp866", "cp1251", "latin-1"):
            try:
                return raw.decode(enc).strip("\x00").strip()
            except UnicodeDecodeError:
                continue
        return raw
    return raw


def _usable_x690_value(raw: Any) -> bool:
    if raw is None:
        return False
    return "SENTINEL_UNINITIALISED" not in repr(raw)


def _value_to_python(val: Any) -> Any:
    if val is None:
        return None
    if hasattr(val, "python"):
        py = val.python
        raw = py() if callable(py) else py
        if _usable_x690_value(raw):
            return _decode_snmp_scalar(raw)
    if hasattr(val, "pyvalue"):
        py = val.pyvalue
        raw = py() if callable(py) else py
        if _usable_x690_value(raw):
            return _decode_snmp_scalar(raw)
    if hasattr(val, "value"):
        raw = val.value
        if _usable_x690_value(raw):
            return _decode_snmp_scalar(raw)
    return val


def _short_error(e: Exception) -> str:
    msg = (str(e).strip() or type(e).__name__)[:240]
    if "timeout" in msg.lower():
        return "timeout: UDP/161 не отвечает или community неверный"
    return msg


def _index_key(oid_str: str, base_oid: str) -> str | None:
    if not oid_str.startswith(base_oid + "."):
        return None
    suffix = oid_str[len(base_oid) + 1 :]
    return suffix or None


async def _safe_get(client: Client, oid: str, timeout: float) -> Any:
    async with asyncio.timeout(timeout):
        return _value_to_python(await client.get(ObjectIdentifier(oid)))


async def _walk_oid_map(client: Client, base_oid: str, timeout: float) -> dict[str, Any]:
    out: dict[str, Any] = {}
    try:
        async with asyncio.timeout(timeout):
            async for vb in client.walk(ObjectIdentifier(base_oid), errors="ignore"):
                oid_str = _oid_to_str(vb.oid)
                key = _index_key(oid_str, base_oid)
                if key is None:
                    continue
                out[key] = _value_to_python(vb.value)
    except Exception:
        return out
    return out


def _bytes_or_str_ip(raw: Any) -> str | None:
    if isinstance(raw, bytes) and len(raw) == 4:
        return ".".join(str(b) for b in raw)
    if isinstance(raw, str):
        s = raw.strip()
        if re.match(r"^\d{1,3}(?:\.\d{1,3}){3}$", s):
            return s
    return None


async def probe_network_snmp(
    ip: str,
    *,
    community: str = "public",
    timeout: float = 1.2,
    port: int = 161,
) -> NetworkSnmpSnapshot:
    """Fast discovery probe: sysDescr/sysName/sysObjectID only."""
    snap = NetworkSnmpSnapshot()
    client = Client(ip, V2C(community), port=port)
    try:
        try:
            snap.sys_descr = str(await _safe_get(client, OID_SYS_DESCR, timeout) or "").strip() or None
        except Exception as e:
            snap.error = f"SNMP: {_short_error(e)}"
            return snap
        try:
            snap.sys_name = str(await _safe_get(client, OID_SYS_NAME, timeout) or "").strip() or None
        except Exception:
            pass
        try:
            oid_raw = await _safe_get(client, OID_SYS_OBJECT_ID, timeout)
            if oid_raw is not None:
                snap.sys_object_id = str(oid_raw).strip().lstrip(".") or None
        except Exception:
            pass
        cls = classify_device(snap.sys_descr, sys_object_id=snap.sys_object_id, sys_name=snap.sys_name)
        snap.device_type = cls.device_type
        snap.vendor = cls.vendor
        snap.model = cls.model
        snap.classify_confidence = cls.confidence
        snap.classify_signals = list(cls.signals)
        snap.is_network_gear = cls.is_network_gear
        if not snap.sys_descr and not snap.sys_name:
            snap.error = "SNMP: пустой ответ"
    except Exception as e:
        snap.error = f"SNMP: {_short_error(e)}"
    return snap


def _pick_entity_chassis(
    class_map: dict[str, Any],
    model_map: dict[str, Any],
    serial_map: dict[str, Any],
    descr_map: dict[str, Any],
    name_map: dict[str, Any],
) -> tuple[str | None, str | None, str | None]:
    """Prefer entPhysicalClass=chassis(3) then module(9) then first non-empty model."""
    preferred_keys: list[str] = []
    for key, cls in class_map.items():
        try:
            c = int(cls)
        except (TypeError, ValueError):
            continue
        if c == 3:  # chassis
            preferred_keys.insert(0, key)
        elif c in {9, 10}:  # module / port
            preferred_keys.append(key)
    keys = preferred_keys or list(set(model_map) | set(serial_map) | set(descr_map))
    model = serial = descr = None
    for key in keys:
        m = str(model_map.get(key) or "").strip() or None
        s = str(serial_map.get(key) or "").strip() or None
        d = str(descr_map.get(key) or name_map.get(key) or "").strip() or None
        if m and not model:
            model = m[:128]
        if s and not serial and s.lower() not in {"n/a", "none", "default string", "to be filled by o.e.m."}:
            serial = s[:128]
        if d and not descr:
            descr = d[:255]
        if model and serial:
            break
    return model, serial, descr


async def fetch_network_snmp(
    ip: str,
    *,
    community: str = "public",
    timeout: float = 5.0,
    port: int = 161,
) -> NetworkSnmpSnapshot:
    """Deep poll: identity + IF-MIB + LLDP/CDP + bridge FDB."""
    snap = await probe_network_snmp(ip, community=community, timeout=min(timeout, 2.5), port=port)
    if snap.error and not snap.sys_descr:
        return snap

    client = Client(ip, V2C(community), port=port)
    walk_timeout = max(timeout * 2.5, 8.0)

    try:
        try:
            loc = str(await _safe_get(client, OID_SYS_LOCATION, timeout) or "").strip()
            snap.sys_location = loc or None
        except Exception:
            pass
        try:
            contact = str(await _safe_get(client, OID_SYS_CONTACT, timeout) or "").strip()
            snap.sys_contact = contact or None
        except Exception:
            pass
        try:
            up = await _safe_get(client, OID_SYS_UPTIME, timeout)
            if up is not None:
                snap.sys_uptime_ticks = int(up)
                snap.sys_uptime_human = _uptime_human(snap.sys_uptime_ticks)
        except Exception:
            pass
        try:
            fwd = await _safe_get(client, OID_IP_FORWARDING, timeout)
            if fwd is not None:
                snap.ip_forwarding = int(fwd) == 1
        except Exception:
            pass
        try:
            bn = await _safe_get(client, OID_DOT1D_BASE_NUM_PORTS, timeout)
            if bn is not None:
                snap.bridge_num_ports = int(bn)
        except Exception:
            pass

        if_descr, if_name, if_type, if_oper, if_speed, if_phys = await asyncio.gather(
            _walk_oid_map(client, OID_IF_DESCR, walk_timeout),
            _walk_oid_map(client, OID_IF_NAME, walk_timeout),
            _walk_oid_map(client, OID_IF_TYPE, walk_timeout),
            _walk_oid_map(client, OID_IF_OPER, walk_timeout),
            _walk_oid_map(client, OID_IF_SPEED, walk_timeout),
            _walk_oid_map(client, OID_IF_PHYS, walk_timeout),
        )
        keys = sorted(set(if_descr) | set(if_name) | set(if_type) | set(if_oper), key=lambda k: int(k) if k.isdigit() else k)
        for key in keys[:256]:
            try:
                itype = int(if_type[key]) if key in if_type and if_type[key] is not None else None
            except (TypeError, ValueError):
                itype = None
            try:
                oper_raw = int(if_oper[key]) if key in if_oper and if_oper[key] is not None else None
            except (TypeError, ValueError):
                oper_raw = None
            try:
                speed = int(if_speed[key]) if key in if_speed and if_speed[key] is not None else None
            except (TypeError, ValueError):
                speed = None
            mac = normalize_mac(if_phys.get(key))
            name = str(if_name.get(key) or "").strip() or None
            descr = str(if_descr.get(key) or "").strip() or None
            snap.interfaces.append(
                SnmpInterface(
                    if_index=key,
                    name=name,
                    descr=descr,
                    if_type=itype,
                    oper_status=_OPER_MAP.get(oper_raw) if oper_raw is not None else None,
                    speed=speed,
                    mac=mac,
                )
            )

        if_by_index = {i.if_index: i for i in snap.interfaces}

        # LLDP
        lldp_name, lldp_port, lldp_pdesc, lldp_sdesc = await asyncio.gather(
            _walk_oid_map(client, OID_LLDP_REM_SYS_NAME, walk_timeout),
            _walk_oid_map(client, OID_LLDP_REM_PORT_ID, walk_timeout),
            _walk_oid_map(client, OID_LLDP_REM_PORT_DESC, walk_timeout),
            _walk_oid_map(client, OID_LLDP_REM_SYS_DESC, walk_timeout),
        )
        for key in sorted(set(lldp_name) | set(lldp_port) | set(lldp_pdesc)):
            parts = key.split(".")
            local_if = parts[1] if len(parts) >= 2 else (parts[0] if parts else None)
            local_port = None
            if local_if and local_if in if_by_index:
                local_port = if_by_index[local_if].name or if_by_index[local_if].descr
            rem_name = str(lldp_name.get(key) or "").strip() or None
            rem_port = str(lldp_port.get(key) or lldp_pdesc.get(key) or "").strip() or None
            rem_desc = str(lldp_sdesc.get(key) or "").strip() or None
            if not rem_name and not rem_port:
                continue
            snap.neighbors.append(
                SnmpNeighbor(
                    protocol="lldp",
                    remote_name=rem_name,
                    remote_port=rem_port,
                    remote_descr=rem_desc,
                    local_if_index=local_if,
                    local_port=local_port,
                )
            )

        # CDP (Cisco)
        cdp_id, cdp_port, cdp_plat, cdp_addr = await asyncio.gather(
            _walk_oid_map(client, OID_CDP_CACHE_DEVICE_ID, walk_timeout),
            _walk_oid_map(client, OID_CDP_CACHE_DEVICE_PORT, walk_timeout),
            _walk_oid_map(client, OID_CDP_CACHE_PLATFORM, walk_timeout),
            _walk_oid_map(client, OID_CDP_CACHE_ADDRESS, walk_timeout),
        )
        for key in sorted(set(cdp_id) | set(cdp_port)):
            parts = key.split(".")
            local_if = parts[0] if parts else None
            local_port = None
            if local_if and local_if in if_by_index:
                local_port = if_by_index[local_if].name or if_by_index[local_if].descr
            rem_name = str(cdp_id.get(key) or "").strip() or None
            rem_port = str(cdp_port.get(key) or "").strip() or None
            rem_desc = str(cdp_plat.get(key) or "").strip() or None
            rem_ip = _bytes_or_str_ip(cdp_addr.get(key))
            if not rem_name and not rem_ip:
                continue
            snap.neighbors.append(
                SnmpNeighbor(
                    protocol="cdp",
                    remote_name=rem_name,
                    remote_port=rem_port,
                    remote_descr=rem_desc,
                    remote_ip=rem_ip,
                    local_if_index=local_if,
                    local_port=local_port,
                )
            )

        # Bridge FDB
        fdb_addr, fdb_port, base_port_if = await asyncio.gather(
            _walk_oid_map(client, OID_DOT1D_TP_FDB_ADDRESS, walk_timeout),
            _walk_oid_map(client, OID_DOT1D_TP_FDB_PORT, walk_timeout),
            _walk_oid_map(client, OID_DOT1D_BASE_PORT_IF, walk_timeout),
        )
        port_to_if = {k: str(v) for k, v in base_port_if.items() if v is not None}
        for key, mac_raw in fdb_addr.items():
            mac = normalize_mac(mac_raw)
            if not mac:
                # OID suffix often encodes MAC as 6 decimal octets
                parts = key.split(".")
                if len(parts) >= 6:
                    try:
                        mac = normalize_mac(bytes(int(p) for p in parts[-6:]))
                    except ValueError:
                        mac = None
            if not mac:
                continue
            port_raw = fdb_port.get(key)
            port_str = str(port_raw).strip() if port_raw is not None else None
            if_index = port_to_if.get(port_str) if port_str else None
            snap.fdb.append(SnmpFdbEntry(mac=mac, port=port_str, if_index=if_index))
            if len(snap.fdb) >= 4000:
                break

        # Device IP addresses (IP-MIB)
        try:
            addr_map = await _walk_oid_map(client, OID_IP_AD_ENT_ADDR, walk_timeout)
            ips: list[str] = []
            for key, val in addr_map.items():
                ip = _bytes_or_str_ip(val) or (str(val).strip() if val else "")
                if not ip and key.count(".") >= 3:
                    # suffix often is the IP itself
                    parts = key.split(".")
                    cand = ".".join(parts[-4:])
                    if _bytes_or_str_ip(cand) or re.match(r"^\d{1,3}(?:\.\d{1,3}){3}$", cand):
                        ip = cand
                if ip and ip not in ips and not ip.startswith("127."):
                    ips.append(ip)
            snap.ip_addresses = ips[:64]
        except Exception:
            pass

        # ARP table → enrich FDB if bridge table empty/short
        if len(snap.fdb) < 20:
            try:
                arp_phys = await _walk_oid_map(client, OID_IP_NET_TO_MEDIA_PHYS, walk_timeout)
                for key, mac_raw in list(arp_phys.items())[:1500]:
                    mac = normalize_mac(mac_raw)
                    if not mac:
                        continue
                    parts = key.split(".")
                    if_index = parts[0] if parts else None
                    snap.fdb.append(SnmpFdbEntry(mac=mac, port=None, if_index=if_index))
            except Exception:
                pass

        # ENTITY-MIB: model / serial / chassis descr
        try:
            ent_class, ent_model, ent_serial, ent_descr, ent_name = await asyncio.gather(
                _walk_oid_map(client, OID_ENT_PHYS_CLASS, min(walk_timeout, 10.0)),
                _walk_oid_map(client, OID_ENT_PHYS_MODEL, min(walk_timeout, 10.0)),
                _walk_oid_map(client, OID_ENT_PHYS_SERIAL, min(walk_timeout, 10.0)),
                _walk_oid_map(client, OID_ENT_PHYS_DESCR, min(walk_timeout, 10.0)),
                _walk_oid_map(client, OID_ENT_PHYS_NAME, min(walk_timeout, 10.0)),
            )
            model, serial, edescr = _pick_entity_chassis(
                ent_class, ent_model, ent_serial, ent_descr, ent_name
            )
            if model:
                snap.model = model
            if serial:
                snap.serial_number = serial
            entity_descr = edescr
        except Exception:
            entity_descr = None

        hints = build_hints_from_interfaces(
            snap.interfaces,
            fdb_count=len(snap.fdb),
            neighbor_count=len(snap.neighbors),
            ip_forwarding=snap.ip_forwarding,
            entity_model=snap.model,
            entity_serial=snap.serial_number,
            entity_descr=entity_descr,
        )
        if snap.bridge_num_ports and snap.bridge_num_ports > 0:
            hints.has_bridge_fdb = True
            hints.ethernet_ports = max(hints.ethernet_ports, int(snap.bridge_num_ports))

        cls = classify_device(
            snap.sys_descr,
            sys_object_id=snap.sys_object_id,
            sys_name=snap.sys_name,
            hints=hints,
        )
        snap.device_type = cls.device_type
        snap.vendor = cls.vendor or snap.vendor
        snap.model = cls.model or snap.model
        snap.classify_confidence = cls.confidence
        snap.classify_signals = list(cls.signals)
        snap.is_network_gear = cls.is_network_gear or bool(snap.interfaces) or bool(snap.neighbors)
    except Exception as e:
        if not snap.sys_descr:
            snap.error = f"SNMP: {_short_error(e)}"
        else:
            snap.error = None  # identity ok; deep walk partially failed is fine
    return snap
