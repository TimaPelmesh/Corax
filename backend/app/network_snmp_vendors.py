"""Vendor-aware SNMP identity and neighbor parsers.

Walk maps are parsed offline — no live probes here. OIDs follow published MIBs:

- IEEE 802.1AB LLDP-MIB, Q-BRIDGE-MIB, IF-MIB, ENTITY-MIB
- Cisco CDP CISCO-CDP-MIB (1.3.6.1.4.1.9)
- MikroTik MNDP MIKROTIK-MIB mtxrNeighbor (1.3.6.1.4.1.14988)
- HPE/H3C Comware HH3C-NDP-MIB (1.3.6.1.4.1.25506)
- Foundry/Brocade/Ruckus ICX FDP (1.3.6.1.4.1.1991)
- Extreme EDP EXTREME-EDP-MIB (1.3.6.1.4.1.1916)
- Dell/Nortel/Avaya ISDP (1.3.6.1.4.1.45) and Radlan (1.3.6.1.4.1.89)
- Huawei NDP / LLDP extensions (1.3.6.1.4.1.2011)
- Aruba (1.3.6.1.4.1.14823), Juniper, Fortinet, Palo Alto, Ubiquiti, Eltex, Zyxel
"""

from __future__ import annotations

import re
from typing import Any

from app.network_classify import normalize_mac
from app.text_sanitize import pg_text

# IEEE LLDP extras (beyond the core remSysName/port walks in network_snmp.py)
OID_LLDP_REM_CHASSIS = "1.0.8802.1.1.2.1.4.1.1.5"
OID_LLDP_LOC_PORT_ID = "1.0.8802.1.1.2.1.3.7.1.3"
OID_LLDP_LOC_PORT_DESC = "1.0.8802.1.1.2.1.3.7.1.4"
OID_IF_ALIAS = "1.3.6.1.2.1.31.1.1.1.18"

# Q-BRIDGE-MIB — VLAN-aware FDB (Cisco/HPE/Juniper/Eltex)
OID_DOT1Q_FDB_PORT = "1.3.6.1.2.1.17.7.1.2.2.1.2"

# MikroTik MNDP
OID_MTXR_NEIGH_IP = "1.3.6.1.4.1.14988.1.1.11.1.1.2"
OID_MTXR_NEIGH_MAC = "1.3.6.1.4.1.14988.1.1.11.1.1.3"
OID_MTXR_NEIGH_VER = "1.3.6.1.4.1.14988.1.1.11.1.1.4"
OID_MTXR_NEIGH_PLAT = "1.3.6.1.4.1.14988.1.1.11.1.1.5"
OID_MTXR_NEIGH_ID = "1.3.6.1.4.1.14988.1.1.11.1.1.6"
OID_MTXR_NEIGH_IF = "1.3.6.1.4.1.14988.1.1.11.1.1.8"
OID_MTXR_SERIAL = "1.3.6.1.4.1.14988.1.1.7.3.0"

# HPE Comware / H3C NDP
OID_HH3C_NDP_DEV = "1.3.6.1.4.1.25506.2.8.1.2.1.3"
OID_HH3C_NDP_PORT = "1.3.6.1.4.1.25506.2.8.1.2.1.4"
OID_HH3C_NDP_ADDR = "1.3.6.1.4.1.25506.2.8.1.2.1.5"
OID_HH3C_NDP_PLAT = "1.3.6.1.4.1.25506.2.8.1.2.1.7"

# Foundry / Brocade / Ruckus ICX FDP
OID_FDP_ID = "1.3.6.1.4.1.1991.1.1.3.20.1.1.3"
OID_FDP_PORT = "1.3.6.1.4.1.1991.1.1.3.20.1.1.4"
OID_FDP_ADDR = "1.3.6.1.4.1.1991.1.1.3.20.1.1.5"
OID_FDP_PLAT = "1.3.6.1.4.1.1991.1.1.3.20.1.1.6"

# Extreme EDP
OID_EDP_NAME = "1.3.6.1.4.1.1916.1.13.3.1.3"
OID_EDP_RIF = "1.3.6.1.4.1.1916.1.13.3.1.4"

# Nortel/Avaya/Dell ISDP
OID_ISDP_ADDR = "1.3.6.1.4.1.45.1.6.13.2.1.1.3"
OID_ISDP_ID = "1.3.6.1.4.1.45.1.6.13.2.1.1.5"
OID_ISDP_PORT = "1.3.6.1.4.1.45.1.6.13.2.1.1.7"
OID_ISDP_PLAT = "1.3.6.1.4.1.45.1.6.13.2.1.1.8"

# Radlan / Dell N-series / some Eltex / TP-Link
OID_RL_ISDP_ID = "1.3.6.1.4.1.89.53.4.1.1.2"
OID_RL_ISDP_PORT = "1.3.6.1.4.1.89.53.4.1.1.3"
OID_RL_ISDP_ADDR = "1.3.6.1.4.1.89.53.4.1.1.4"
OID_RL_ISDP_PLAT = "1.3.6.1.4.1.89.53.4.1.1.5"

# Huawei NDP (VRP)
OID_HW_NDP_DEV = "1.3.6.1.4.1.2011.5.25.37.1.2.1.1.3"
OID_HW_NDP_PORT = "1.3.6.1.4.1.2011.5.25.37.1.2.1.1.4"
OID_HW_NDP_ADDR = "1.3.6.1.4.1.2011.5.25.37.1.2.1.1.5"

# Identity scalars
OID_JNX_SERIAL = "1.3.6.1.4.1.2636.3.1.3.0"
OID_FG_SERIAL = "1.3.6.1.4.1.12356.100.1.1.1.0"
OID_FG_VERSION = "1.3.6.1.4.1.12356.101.4.1.1.0"
OID_PAN_SERIAL = "1.3.6.1.4.1.25461.2.1.2.1.3.0"
OID_PAN_VERSION = "1.3.6.1.4.1.25461.2.1.2.1.1.0"

NEIGHBOR_WALK_OIDS: tuple[str, ...] = (
    OID_LLDP_REM_CHASSIS,
    OID_LLDP_LOC_PORT_ID,
    OID_LLDP_LOC_PORT_DESC,
    OID_IF_ALIAS,
    OID_DOT1Q_FDB_PORT,
    OID_MTXR_NEIGH_IP,
    OID_MTXR_NEIGH_MAC,
    OID_MTXR_NEIGH_VER,
    OID_MTXR_NEIGH_PLAT,
    OID_MTXR_NEIGH_ID,
    OID_MTXR_NEIGH_IF,
    OID_HH3C_NDP_DEV,
    OID_HH3C_NDP_PORT,
    OID_HH3C_NDP_ADDR,
    OID_HH3C_NDP_PLAT,
    OID_FDP_ID,
    OID_FDP_PORT,
    OID_FDP_ADDR,
    OID_FDP_PLAT,
    OID_EDP_NAME,
    OID_EDP_RIF,
    OID_ISDP_ADDR,
    OID_ISDP_ID,
    OID_ISDP_PORT,
    OID_ISDP_PLAT,
    OID_RL_ISDP_ID,
    OID_RL_ISDP_PORT,
    OID_RL_ISDP_ADDR,
    OID_RL_ISDP_PLAT,
    OID_HW_NDP_DEV,
    OID_HW_NDP_PORT,
    OID_HW_NDP_ADDR,
)

DISCOVERY_PROTOCOLS = frozenset(
    {"lldp", "cdp", "mndp", "ndp", "fdp", "edp", "isdp", "hndp"}
)

_IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


def _txt(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, bytes):
        return pg_text(raw, max_len=255)
    return pg_text(raw, max_len=255)


def _ip(raw: Any) -> str | None:
    if isinstance(raw, bytes) and len(raw) == 4:
        ip = ".".join(str(b) for b in raw)
        return None if ip in {"0.0.0.0", "255.255.255.255"} else ip
    if isinstance(raw, (list, tuple)) and len(raw) == 4:
        try:
            octs = [int(x) for x in raw]
        except (TypeError, ValueError):
            return None
        if all(0 <= o <= 255 for o in octs):
            ip = ".".join(str(o) for o in octs)
            return None if ip in {"0.0.0.0", "255.255.255.255"} else ip
    s = _txt(raw)
    if s and _IP_RE.match(s) and s not in {"0.0.0.0", "255.255.255.255"}:
        return s
    return None


def _local_if_from_key(key: str, *, pos: int = 0) -> str | None:
    parts = [p for p in (key or "").split(".") if p]
    if len(parts) <= pos:
        return None
    return parts[pos]


def _neighbor(
    *,
    protocol: str,
    remote_name: str | None = None,
    remote_port: str | None = None,
    remote_descr: str | None = None,
    remote_ip: str | None = None,
    local_if_index: str | None = None,
    local_port: str | None = None,
    remote_chassis: str | None = None,
) -> dict[str, Any] | None:
    chassis = normalize_mac(remote_chassis) or (_txt(remote_chassis) if remote_chassis else None)
    name = _txt(remote_name)
    port = _txt(remote_port)
    ip = _ip(remote_ip) or (name if name and _IP_RE.match(name) else None)
    if not name and not ip and not chassis:
        return None
    return {
        "protocol": protocol,
        "remote_name": name,
        "remote_port": port,
        "remote_descr": _txt(remote_descr),
        "remote_ip": ip,
        "local_if_index": _txt(local_if_index),
        "local_port": _txt(local_port),
        "remote_chassis": chassis,
    }


def merge_neighbors(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Dedupe across protocols: same remote (ip / chassis / name) on the same local port."""
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for group in groups:
        for n in group:
            if not isinstance(n, dict):
                continue
            ident = (
                str(n.get("remote_ip") or n.get("remote_chassis") or n.get("remote_name") or "")
                .strip()
                .lower()
            )
            local = str(n.get("local_if_index") or n.get("local_port") or "").strip().lower()
            proto = str(n.get("protocol") or "").strip().lower()
            key = (ident, local, proto)
            if not ident or key in seen:
                continue
            seen.add(key)
            out.append(n)
    return out


def parse_mikrotik_mndp(
    ip_map: dict[str, Any],
    mac_map: dict[str, Any],
    ident_map: dict[str, Any],
    plat_map: dict[str, Any],
    if_map: dict[str, Any],
    *,
    if_by_index: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    keys = set(ip_map) | set(mac_map) | set(ident_map)
    out: list[dict[str, Any]] = []
    for key in sorted(keys):
        local_if = _local_if_from_key(key)
        local_port = None
        if local_if and if_by_index and local_if in if_by_index:
            iface = if_by_index[local_if]
            local_port = getattr(iface, "name", None) or getattr(iface, "descr", None)
            if isinstance(iface, dict):
                local_port = iface.get("name") or iface.get("descr")
        if not local_port:
            local_port = _txt(if_map.get(key))
        n = _neighbor(
            protocol="mndp",
            remote_name=_txt(ident_map.get(key)),
            remote_descr=_txt(plat_map.get(key)),
            remote_ip=ip_map.get(key),
            local_if_index=local_if,
            local_port=local_port,
            remote_chassis=mac_map.get(key),
        )
        if n:
            out.append(n)
    return out


def parse_generic_cache(
    *,
    protocol: str,
    id_map: dict[str, Any],
    port_map: dict[str, Any],
    addr_map: dict[str, Any] | None = None,
    plat_map: dict[str, Any] | None = None,
    local_pos: int = 0,
    if_by_index: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    addr_map = addr_map or {}
    plat_map = plat_map or {}
    keys = set(id_map) | set(port_map) | set(addr_map)
    out: list[dict[str, Any]] = []
    for key in sorted(keys):
        local_if = _local_if_from_key(key, pos=local_pos)
        local_port = None
        if local_if and if_by_index and local_if in if_by_index:
            iface = if_by_index[local_if]
            local_port = getattr(iface, "name", None) or getattr(iface, "descr", None)
            if isinstance(iface, dict):
                local_port = iface.get("name") or iface.get("descr")
        n = _neighbor(
            protocol=protocol,
            remote_name=_txt(id_map.get(key)),
            remote_port=_txt(port_map.get(key)),
            remote_descr=_txt(plat_map.get(key)),
            remote_ip=addr_map.get(key),
            local_if_index=local_if,
            local_port=local_port,
        )
        if n:
            out.append(n)
    return out


def parse_qbridge_fdb(port_map: dict[str, Any]) -> list[dict[str, Any]]:
    """dot1qTpFdbPort INDEX is vlanId + 6 MAC octets."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for key, port_raw in port_map.items():
        parts = [p for p in (key or "").split(".") if p]
        if len(parts) < 7:
            continue
        try:
            octs = [int(p) for p in parts[-6:]]
        except ValueError:
            continue
        if not all(0 <= o <= 255 for o in octs):
            continue
        mac = normalize_mac(bytes(octs))
        if not mac or mac in seen:
            continue
        seen.add(mac)
        port_str = pg_text(port_raw, max_len=32)
        out.append({"mac": mac, "port": port_str, "if_index": port_str})
        if len(out) >= 4000:
            break
    return out


def apply_lldp_local_ports(
    neighbors: list[dict[str, Any]],
    loc_id: dict[str, Any],
    loc_desc: dict[str, Any],
    if_by_index: dict[str, Any] | None = None,
) -> None:
    """lldpLocPortNum often is not ifIndex — map via locPortId/Desc onto IF-MIB names."""
    loc_names: dict[str, str] = {}
    for key, val in {**loc_desc, **loc_id}.items():
        name = _txt(val)
        if name:
            loc_names[key.split(".")[0] if "." in key else key] = name
    if not loc_names:
        return
    name_to_if: dict[str, str] = {}
    if if_by_index:
        for idx, iface in if_by_index.items():
            for cand in (
                getattr(iface, "name", None),
                getattr(iface, "descr", None),
                iface.get("name") if isinstance(iface, dict) else None,
                iface.get("descr") if isinstance(iface, dict) else None,
            ):
                label = _txt(cand)
                if label:
                    name_to_if.setdefault(label.lower(), str(idx))
    for n in neighbors:
        if n.get("protocol") != "lldp":
            continue
        local_if = str(n.get("local_if_index") or "")
        mapped_name = loc_names.get(local_if)
        if mapped_name:
            n["local_port"] = n.get("local_port") or mapped_name
            real_if = name_to_if.get(mapped_name.lower())
            if real_if:
                n["local_if_index"] = real_if


def apply_lldp_chassis(neighbors: list[dict[str, Any]], chassis_map: dict[str, Any]) -> None:
    for n in neighbors:
        if n.get("protocol") != "lldp" or n.get("remote_chassis"):
            continue
        key = str(n.get("local_if_index") or "")
        # chassis walk keys are timeMark.localPort.remIndex — try suffix match
        hit = chassis_map.get(key)
        if hit is None:
            for ck, cv in chassis_map.items():
                if ck == key or ck.endswith("." + key) or key.endswith(ck):
                    hit = cv
                    break
        mac = normalize_mac(hit)
        if mac:
            n["remote_chassis"] = mac


def identity_oids_for(sys_object_id: str | None, vendor: str | None) -> list[str]:
    oid = (sys_object_id or "").strip().lstrip(".")
    vendor_l = (vendor or "").lower()
    out: list[str] = []
    if oid.startswith("1.3.6.1.4.1.14988") or "mikrotik" in vendor_l:
        out.append(OID_MTXR_SERIAL)
    if oid.startswith("1.3.6.1.4.1.2636") or "juniper" in vendor_l:
        out.append(OID_JNX_SERIAL)
    if oid.startswith("1.3.6.1.4.1.12356") or "fortinet" in vendor_l:
        out.extend([OID_FG_SERIAL, OID_FG_VERSION])
    if oid.startswith("1.3.6.1.4.1.25461") or "palo" in vendor_l:
        out.extend([OID_PAN_SERIAL, OID_PAN_VERSION])
    return out


def apply_identity_scalars(snap: Any, values: dict[str, Any]) -> None:
    serial = _txt(values.get(OID_MTXR_SERIAL) or values.get(OID_JNX_SERIAL) or values.get(OID_FG_SERIAL) or values.get(OID_PAN_SERIAL))
    if serial and not getattr(snap, "serial_number", None):
        snap.serial_number = serial[:128]
    version = _txt(values.get(OID_FG_VERSION) or values.get(OID_PAN_VERSION))
    if version and not getattr(snap, "model", None):
        snap.model = version[:128]


def extra_walk_oids_for(
    sys_object_id: str | None,
    vendor: str | None,
    *,
    neighbor_count: int = 0,
) -> tuple[str, ...]:
    """Pick vendor neighbor tables. Fallback set only when LLDP/CDP found nothing."""
    oid = (sys_object_id or "").strip().lstrip(".")
    vendor_l = (vendor or "").lower()
    out: list[str] = []

    def add(*oids: str) -> None:
        for item in oids:
            if item not in out:
                out.append(item)

    mikrotik = oid.startswith("1.3.6.1.4.1.14988") or "mikrotik" in vendor_l
    h3c = oid.startswith("1.3.6.1.4.1.25506") or oid.startswith("1.3.6.1.4.1.11") or "hpe" in vendor_l or "aruba" in vendor_l
    foundry = oid.startswith("1.3.6.1.4.1.1991") or oid.startswith("1.3.6.1.4.1.25053") or "ruckus" in vendor_l
    extreme = oid.startswith("1.3.6.1.4.1.1916") or "extreme" in vendor_l
    dell = oid.startswith("1.3.6.1.4.1.674") or oid.startswith("1.3.6.1.4.1.45") or oid.startswith("1.3.6.1.4.1.89") or "dell" in vendor_l
    huawei = oid.startswith("1.3.6.1.4.1.2011") or "huawei" in vendor_l
    eltex = oid.startswith("1.3.6.1.4.1.35265") or "eltex" in vendor_l
    tplink = oid.startswith("1.3.6.1.4.1.11863") or "tp-link" in vendor_l or "tp_link" in vendor_l

    if mikrotik:
        add(OID_MTXR_NEIGH_IP, OID_MTXR_NEIGH_MAC, OID_MTXR_NEIGH_PLAT, OID_MTXR_NEIGH_ID, OID_MTXR_NEIGH_IF)
    if h3c or eltex:
        add(OID_HH3C_NDP_DEV, OID_HH3C_NDP_PORT, OID_HH3C_NDP_ADDR, OID_HH3C_NDP_PLAT)
    if foundry:
        add(OID_FDP_ID, OID_FDP_PORT, OID_FDP_ADDR, OID_FDP_PLAT)
    if extreme:
        add(OID_EDP_NAME, OID_EDP_RIF)
    if dell or eltex or tplink:
        add(OID_ISDP_ID, OID_ISDP_PORT, OID_ISDP_ADDR, OID_ISDP_PLAT, OID_RL_ISDP_ID, OID_RL_ISDP_PORT, OID_RL_ISDP_ADDR, OID_RL_ISDP_PLAT)
    if huawei:
        add(OID_HW_NDP_DEV, OID_HW_NDP_PORT, OID_HW_NDP_ADDR)

    if neighbor_count == 0 and not out:
        add(
            OID_MTXR_NEIGH_IP, OID_MTXR_NEIGH_MAC, OID_MTXR_NEIGH_ID, OID_MTXR_NEIGH_PLAT, OID_MTXR_NEIGH_IF,
            OID_HH3C_NDP_DEV, OID_HH3C_NDP_PORT, OID_HH3C_NDP_ADDR, OID_HH3C_NDP_PLAT,
            OID_FDP_ID, OID_FDP_PORT, OID_FDP_ADDR,
            OID_ISDP_ID, OID_ISDP_PORT, OID_ISDP_ADDR,
        )
    return tuple(out)


def parse_vendor_neighbor_maps(
    by_oid: dict[str, dict[str, Any]],
    *,
    if_by_index: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    groups: list[list[dict[str, Any]]] = []
    if OID_MTXR_NEIGH_IP in by_oid or OID_MTXR_NEIGH_ID in by_oid:
        groups.append(
            parse_mikrotik_mndp(
                by_oid.get(OID_MTXR_NEIGH_IP, {}),
                by_oid.get(OID_MTXR_NEIGH_MAC, {}),
                by_oid.get(OID_MTXR_NEIGH_ID, {}),
                by_oid.get(OID_MTXR_NEIGH_PLAT, {}),
                by_oid.get(OID_MTXR_NEIGH_IF, {}),
                if_by_index=if_by_index,
            )
        )
    if OID_HH3C_NDP_DEV in by_oid:
        groups.append(
            parse_generic_cache(
                protocol="ndp",
                id_map=by_oid.get(OID_HH3C_NDP_DEV, {}),
                port_map=by_oid.get(OID_HH3C_NDP_PORT, {}),
                addr_map=by_oid.get(OID_HH3C_NDP_ADDR, {}),
                plat_map=by_oid.get(OID_HH3C_NDP_PLAT, {}),
                if_by_index=if_by_index,
            )
        )
    if OID_FDP_ID in by_oid:
        groups.append(
            parse_generic_cache(
                protocol="fdp",
                id_map=by_oid.get(OID_FDP_ID, {}),
                port_map=by_oid.get(OID_FDP_PORT, {}),
                addr_map=by_oid.get(OID_FDP_ADDR, {}),
                plat_map=by_oid.get(OID_FDP_PLAT, {}),
                if_by_index=if_by_index,
            )
        )
    if OID_EDP_NAME in by_oid:
        groups.append(
            parse_generic_cache(
                protocol="edp",
                id_map=by_oid.get(OID_EDP_NAME, {}),
                port_map=by_oid.get(OID_EDP_RIF, {}),
                if_by_index=if_by_index,
            )
        )
    if OID_ISDP_ID in by_oid:
        groups.append(
            parse_generic_cache(
                protocol="isdp",
                id_map=by_oid.get(OID_ISDP_ID, {}),
                port_map=by_oid.get(OID_ISDP_PORT, {}),
                addr_map=by_oid.get(OID_ISDP_ADDR, {}),
                plat_map=by_oid.get(OID_ISDP_PLAT, {}),
                if_by_index=if_by_index,
            )
        )
    if OID_RL_ISDP_ID in by_oid:
        groups.append(
            parse_generic_cache(
                protocol="isdp",
                id_map=by_oid.get(OID_RL_ISDP_ID, {}),
                port_map=by_oid.get(OID_RL_ISDP_PORT, {}),
                addr_map=by_oid.get(OID_RL_ISDP_ADDR, {}),
                plat_map=by_oid.get(OID_RL_ISDP_PLAT, {}),
                if_by_index=if_by_index,
            )
        )
    if OID_HW_NDP_DEV in by_oid:
        groups.append(
            parse_generic_cache(
                protocol="hndp",
                id_map=by_oid.get(OID_HW_NDP_DEV, {}),
                port_map=by_oid.get(OID_HW_NDP_PORT, {}),
                addr_map=by_oid.get(OID_HW_NDP_ADDR, {}),
                if_by_index=if_by_index,
            )
        )
    return merge_neighbors(*groups)


def enterprise_vendor(sys_object_id: str | None) -> str | None:
    oid = (sys_object_id or "").strip().lstrip(".")
    mapping = (
        ("1.3.6.1.4.1.9.", "Cisco"),
        ("1.3.6.1.4.1.29671.", "Cisco Meraki"),
        ("1.3.6.1.4.1.14988.", "MikroTik"),
        ("1.3.6.1.4.1.11.", "HPE/Aruba"),
        ("1.3.6.1.4.1.14823.", "HPE/Aruba"),
        ("1.3.6.1.4.1.47196.", "HPE/Aruba"),
        ("1.3.6.1.4.1.25506.", "HPE/Aruba"),
        ("1.3.6.1.4.1.41112.", "Ubiquiti"),
        ("1.3.6.1.4.1.2636.", "Juniper"),
        ("1.3.6.1.4.1.2011.", "Huawei"),
        ("1.3.6.1.4.1.12356.", "Fortinet"),
        ("1.3.6.1.4.1.25461.", "Palo Alto"),
        ("1.3.6.1.4.1.674.", "Dell"),
        ("1.3.6.1.4.1.45.", "Dell"),
        ("1.3.6.1.4.1.89.", "Dell"),
        ("1.3.6.1.4.1.1991.", "Ruckus"),
        ("1.3.6.1.4.1.25053.", "Ruckus"),
        ("1.3.6.1.4.1.1916.", "Extreme"),
        ("1.3.6.1.4.1.11863.", "TP-Link"),
        ("1.3.6.1.4.1.171.", "D-Link"),
        ("1.3.6.1.4.1.4526.", "Netgear"),
        ("1.3.6.1.4.1.890.", "Zyxel"),
        ("1.3.6.1.4.1.35265.", "Eltex"),
        ("1.3.6.1.4.1.207.", "Allied Telesis"),
        ("1.3.6.1.4.1.4881.", "Ruijie"),
        ("1.3.6.1.4.1.17713.", "Cambium"),
        ("1.3.6.1.4.1.2604.", "Sophos"),
        ("1.3.6.1.4.1.2620.", "Check Point"),
    )
    for prefix, name in mapping:
        if oid.startswith(prefix) or oid.startswith(prefix.rstrip(".")):
            return name
    return None
