from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Types stored/shown on the Network tab (printers stay on their own page).
NETWORK_DEVICE_TYPES = frozenset(
    {
        "switch",
        "router",
        "ap",
        "firewall",
        "controller",
        "server",
        "nas",
        "voip",
        "ups",
        "camera",
        "modem",
        "unknown",
    }
)

# Printer MIB / vendor markers — never store as network gear.
_PRINTER_RE = re.compile(
    r"\b(printer|laserjet|inkjet|multifunction|mfp|jetdirect|bizhub|ineo|"
    r"officejet|deskjet|pagewide|ricoh|kyocera|brother|xerox|epson|"
    r"konica|minolta|toshiba\s*tec|prtgeneral)\b|"
    r"hewlett.?packard.*(laser|office|desk)|hp\s*eprint",
    re.I,
)

_WORKSTATION_RE = re.compile(
    r"windows\s*(10|11|7|8|xp)\b|"
    r"darwin kernel|mac\s*os\s*x|"
    r"hardware:\s*intel.*family|"
    r"\b(ubuntu|fedora|centos|debian)\b.*\b(desktop|workstation)\b",
    re.I,
)

_SERVER_RE = re.compile(
    r"\b(windows\s*server|esxi|vcenter|proxmox|hyper-?v|xenserver|"
    r"vmware\s*esx|red\s*hat\s*enterprise|rhel\s*\d|centos\s*linux\s*(7|8|9)|"
    r"ubuntu\s*server|debian\s*gnu|suse\s*linux\s*enterprise|"
    r"freebsd|openbsd|illumos|smartos|"
    r"supermicro|dell\s*idrac|ilo\s*\d|imm2|xclarity|"
    r"ipmi|bmc\b|out-?of-?band)\b",
    re.I,
)

_NAS_RE = re.compile(
    r"\b(synology|diskstation|qnap|truenas|freenas|openmediavault|"
    r"buffalo\s*terastation|wd\s*my\s*cloud|netgear\s*ready|"
    r"asustor|terra\s*master|nas4free|unraid)\b",
    re.I,
)

_VOIP_RE = re.compile(
    r"\b(yealink|grandstream|polycom|poly\s*vvx|snom|fanvil|"
    r"cisco\s*(ip\s*)?phone|sip\s*phone|asterisk|freepbx|3cx|"
    r"mitel|avaya|panasonic\s*kx|voip|ip\s*pbx|gatekeeper)\b",
    re.I,
)

_UPS_RE = re.compile(
    r"\b(ups\b|apc\b|smart-?ups|powerware|eaton|liebert|vertiv|"
    r"cyberpower|riello|socomec|powercom|ippon|njoy|"
    r"uninterruptible|network\s*management\s*card)\b",
    re.I,
)

_CAMERA_RE = re.compile(
    r"\b(hikvision|dahua|axis\s*communications|bosch\s*security|"
    r"hanwha|samsung\s*techwin|uniview|reolink|foscam|"
    r"ip\s*camera|network\s*camera|nvr\b|dvr\b|video\s*surveillance|"
    r"onvif|milesight)\b",
    re.I,
)

_MODEM_RE = re.compile(
    r"\b(ont\b|onu\b|olt\b|gpon|epon|xdsl|adsl|vdsl|cable\s*modem|"
    r"docsis|optical\s*network|fiber\s*ont|zyxel\s*vmg|"
    r"huawei\s*hg|sercomm|technicolor|arrisi|motorola\s*sb)\b",
    re.I,
)

_CONTROLLER_RE = re.compile(
    r"\b(wifi\s*controller|wireless\s*controller|wlan\s*controller|"
    r"unifi\s*controller|omada\s*controller|mobility\s*controller|"
    r"aruba\s*controller|cisco\s*wlc|catalyst\s*9800|"
    r"ruckus\s*smartzone|mist\s*ap)\b",
    re.I,
)

_SWITCH_RE = re.compile(
    r"\b(switch|officeconnect|superstack|catalyst|nexus|procurve|aruba|"
    r"powerconnect|dgs-|des-|dgs\d|des\d|tl-sg|tl-sl|gs\d{3,}|sg\d{3,}|"
    r"crs\d|css\d|sw[\-_ ]?\d|comware|vrp|junos|stackable|"
    r"\d{2,3}[gt]?[- ]?(port|poe)|poe\+?\s*switch)\b",
    re.I,
)
_ROUTER_RE = re.compile(
    r"\b(router|gateway|isr[\d\-]|asr[\d\-]|edge\s*router|mikrotik|routeros|"
    r"vyos|opnsense|pfsense|ccr\d|rb\d{3,}|"
    r"ios\s*software.*isr|c\d{4}.*software|openwrt|dd-?wrt|tomato\s*firmware|"
    r"keenetic|zyxel\s*armor|asuswrt|tplink\s*archer)\b",
    re.I,
)
_AP_RE = re.compile(
    r"\b(access\s*point|wireless\s*ap|\bwap\b|unifi|ubiquiti|aironet|"
    r"cAP|wAP|uap[- ]|"
    r"nano\s*station|litebeam|powerbeam|wave\s*ap|omada|"
    r"instant\s*on.*ap|aruba\s*ap|eap\d{3,}|cap\s*ac)\b",
    re.I,
)
_FIREWALL_RE = re.compile(
    r"\b(firewall|asa[\d\-]|palo\s*alto|fortinet|fortigate|sophos|"
    r"checkpoint|sonicwall|utm|ngfw|security\s*appliance|"
    r"threat\s*defense|firepower)\b",
    re.I,
)

# Hostname heuristics (common IT naming)
_HOST_SWITCH_RE = re.compile(r"^(sw|switch|tor|core|access|asw|dsw)[-_.]", re.I)
_HOST_ROUTER_RE = re.compile(r"^(rtr|router|gw|gateway|edge|br)[-_.]", re.I)
_HOST_AP_RE = re.compile(r"^(ap|wap|wifi|wifiap|uap)[-_.]", re.I)
_HOST_FW_RE = re.compile(r"^(fw|firewall|utm|asa|fg)[-_.]", re.I)
_HOST_SERVER_RE = re.compile(r"^(srv|server|svc|app|db|dc|ad|fs|file|mail|mx|proxy|vpn)[-_.]", re.I)
_HOST_NAS_RE = re.compile(r"^(nas|storage|backup|bak)[-_.]", re.I)
_HOST_VOIP_RE = re.compile(r"^(voip|pbx|sip|phone|ata)[-_.]", re.I)
_HOST_UPS_RE = re.compile(r"^(ups|pdu)[-_.]", re.I)
_HOST_CAM_RE = re.compile(r"^(cam|nvr|dvr|cctv|ipcam)[-_.]", re.I)
_HOST_CTRL_RE = re.compile(r"^(wlc|controller|unifi|omada)[-_.]", re.I)

_VENDOR_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bcisco\b|catalyst|ios\s*xe|nx-os|aironet|isr\b|asa\b", re.I), "Cisco"),
    (re.compile(r"\bmikrotik\b|routeros", re.I), "MikroTik"),
    (re.compile(r"\bubiquiti\b|unifi|edge(os|switch)|edgerouter", re.I), "Ubiquiti"),
    (re.compile(r"\bhp\b|hewlett|procurve|aruba|officeconnect|comware|instant\s*on", re.I), "HPE/Aruba"),
    (re.compile(r"\bdell\b|powerconnect|force10|os\d0|n\d{4}|idrac", re.I), "Dell"),
    (re.compile(r"\bjuniper\b|junos|ex\d{4}|srx", re.I), "Juniper"),
    (re.compile(r"\bfortinet\b|fortigate|fortios", re.I), "Fortinet"),
    (re.compile(r"\btp-?link\b|omada", re.I), "TP-Link"),
    (re.compile(r"\bd-?link\b", re.I), "D-Link"),
    (re.compile(r"\bnetgear\b", re.I), "Netgear"),
    (re.compile(r"\bhuawei\b|vrp|quidway", re.I), "Huawei"),
    (re.compile(r"\bzynel\b|zyxel", re.I), "Zyxel"),
    (re.compile(r"\beltex\b", re.I), "Eltex"),
    (re.compile(r"\bruckus\b|brocade", re.I), "Ruckus"),
    (re.compile(r"\bextreme\b|extremexos", re.I), "Extreme"),
    (re.compile(r"\bpalo\s*alto\b|pan-os", re.I), "Palo Alto"),
    (re.compile(r"synology|diskstation", re.I), "Synology"),
    (re.compile(r"\bqnap\b", re.I), "QNAP"),
    (re.compile(r"\bapc\b|american\s*power", re.I), "APC"),
    (re.compile(r"\beaton\b", re.I), "Eaton"),
    (re.compile(r"hikvision", re.I), "Hikvision"),
    (re.compile(r"\bdahua\b", re.I), "Dahua"),
    (re.compile(r"\baxis\b", re.I), "Axis"),
    (re.compile(r"yealink", re.I), "Yealink"),
    (re.compile(r"grandstream", re.I), "Grandstream"),
    (re.compile(r"\bvmware\b|esxi", re.I), "VMware"),
    (re.compile(r"keenetic", re.I), "Keenetic"),
]

_NETWORK_VENDORS = {
    "Cisco",
    "MikroTik",
    "Ubiquiti",
    "HPE/Aruba",
    "Dell",
    "Juniper",
    "Fortinet",
    "TP-Link",
    "D-Link",
    "Netgear",
    "Huawei",
    "Zyxel",
    "Eltex",
    "Ruckus",
    "Extreme",
    "Palo Alto",
    "Keenetic",
}

_INFRA_VENDORS = _NETWORK_VENDORS | {
    "Synology",
    "QNAP",
    "APC",
    "Eaton",
    "Hikvision",
    "Dahua",
    "Axis",
    "Yealink",
    "Grandstream",
    "VMware",
}

# Enterprise OID prefixes → vendor
_OID_VENDOR: list[tuple[str, str]] = [
    ("1.3.6.1.4.1.9.", "Cisco"),
    ("1.3.6.1.4.1.14988.", "MikroTik"),
    ("1.3.6.1.4.1.41112.", "Ubiquiti"),
    ("1.3.6.1.4.1.11.", "HPE/Aruba"),
    ("1.3.6.1.4.1.47196.", "HPE/Aruba"),
    ("1.3.6.1.4.1.25506.", "HPE/Aruba"),
    ("1.3.6.1.4.1.674.", "Dell"),
    ("1.3.6.1.4.1.2636.", "Juniper"),
    ("1.3.6.1.4.1.12356.", "Fortinet"),
    ("1.3.6.1.4.1.11863.", "TP-Link"),
    ("1.3.6.1.4.1.171.", "D-Link"),
    ("1.3.6.1.4.1.4526.", "Netgear"),
    ("1.3.6.1.4.1.2011.", "Huawei"),
    ("1.3.6.1.4.1.890.", "Zyxel"),
    ("1.3.6.1.4.1.35265.", "Eltex"),
    ("1.3.6.1.4.1.25053.", "Ruckus"),
    ("1.3.6.1.4.1.1916.", "Extreme"),
    ("1.3.6.1.4.1.25461.", "Palo Alto"),
    ("1.3.6.1.4.1.6574.", "Synology"),
    ("1.3.6.1.4.1.24681.", "QNAP"),
    ("1.3.6.1.4.1.318.", "APC"),
    ("1.3.6.1.4.1.534.", "Eaton"),
    ("1.3.6.1.4.1.39165.", "Hikvision"),
    ("1.3.6.1.4.1.800.", "Dahua"),
    ("1.3.6.1.4.1.368.", "Axis"),
    ("1.3.6.1.4.1.6876.", "VMware"),
]

_IFTYPE_ETHERNET = {6, 62, 69, 117}
_IFTYPE_WIFI = {71, 168, 169, 188}

_MODEL_RE = re.compile(
    r"\b("
    r"WS-C\d{4}[A-Z0-9\-]*|C\d{4}-[A-Z0-9\-]+|ISR\d{4}[A-Z0-9\-]*|ASA\d{4}[A-Z0-9\-]*|"
    r"Nexus\s*\d+|EX\d{4}[A-Z0-9\-]*|SRX\d{3,4}[A-Z0-9\-]*|"
    r"J\d{4}[A-Z]|2530-\d+|2540-\d+|2930[A-Z]?-\d+|3810-\d+|5400[A-Z]?|"
    r"CCR\d{4}|CRS\d{3}|RB\d{3,4}[A-Z0-9\-]*|"
    r"UAP-[A-Z0-9\-]+|USW-[A-Z0-9\-]+|UDM-[A-Z0-9\-]*|"
    r"TL-SG\d+|DGS-\d+|DES-\d+|GS\d{3,}|SG\d{3,}|"
    r"FortiGate-\d+[A-Z]*|FG-\d+[A-Z]*|"
    r"DS[\-_]?[A-Z0-9\-]+|RS[\-_]?[A-Z0-9\-]+|"
    r"SMT\d+|SRT\d+|SUA\d+"
    r")\b",
    re.I,
)

_GEAR_TYPES = (
    "switch",
    "router",
    "ap",
    "firewall",
    "controller",
    "server",
    "nas",
    "voip",
    "ups",
    "camera",
    "modem",
)


@dataclass
class ClassifyHints:
    """Signals collected during deep SNMP poll."""

    ethernet_ports: int = 0
    wifi_ports: int = 0
    ports_up: int = 0
    has_bridge_fdb: bool = False
    fdb_entries: int = 0
    ip_forwarding: bool | None = None
    neighbor_count: int = 0
    entity_model: str | None = None
    entity_serial: str | None = None
    entity_descr: str | None = None


@dataclass(frozen=True)
class DeviceClassification:
    device_type: str
    vendor: str | None
    is_network_gear: bool
    confidence: float = 0.0
    model: str | None = None
    signals: tuple[str, ...] = field(default_factory=tuple)

    def to_extras(self) -> dict[str, Any]:
        return {
            "classify_confidence": round(self.confidence, 2),
            "classify_signals": list(self.signals),
            "model": self.model,
        }


def classify_device(
    sys_descr: str | None,
    *,
    sys_object_id: str | None = None,
    sys_name: str | None = None,
    hints: ClassifyHints | None = None,
) -> DeviceClassification:
    blob = " ".join(p for p in (sys_descr or "", sys_name or "", sys_object_id or "") if p).strip()
    hints = hints or ClassifyHints()
    entity_blob = " ".join(
        p for p in (hints.entity_model or "", hints.entity_descr or "", hints.entity_serial or "") if p
    )
    full = f"{blob} {entity_blob}".strip()

    if not full and not hints.ethernet_ports and not hints.has_bridge_fdb:
        return DeviceClassification("unknown", None, False, 0.0, None, ())

    vendor = _vendor_from_oid(sys_object_id) or _vendor_from_text(full)
    model = _extract_model(full) or hints.entity_model
    signals: list[str] = []
    scores: dict[str, float] = {t: 0.0 for t in (*_GEAR_TYPES, "host", "printer", "unknown")}
    scores["unknown"] = 0.05

    if _PRINTER_RE.search(full):
        return DeviceClassification("printer", vendor, False, 0.95, model, ("printer_mib_or_vendor",))

    # Text keyword scores
    for regex, key, weight, sig in (
        (_FIREWALL_RE, "firewall", 3.0, "descr_firewall"),
        (_CONTROLLER_RE, "controller", 3.2, "descr_controller"),
        (_AP_RE, "ap", 3.0, "descr_ap"),
        (_ROUTER_RE, "router", 2.6, "descr_router"),
        (_SWITCH_RE, "switch", 2.6, "descr_switch"),
        (_NAS_RE, "nas", 3.2, "descr_nas"),
        (_UPS_RE, "ups", 3.2, "descr_ups"),
        (_CAMERA_RE, "camera", 3.2, "descr_camera"),
        (_VOIP_RE, "voip", 3.0, "descr_voip"),
        (_MODEM_RE, "modem", 3.0, "descr_modem"),
        (_SERVER_RE, "server", 2.8, "descr_server"),
    ):
        if regex.search(full):
            scores[key] += weight
            signals.append(sig)

    # Hostname naming
    name = (sys_name or "").strip()
    if name:
        for regex, key, weight, sig in (
            (_HOST_FW_RE, "firewall", 1.5, "hostname_fw"),
            (_HOST_CTRL_RE, "controller", 1.5, "hostname_ctrl"),
            (_HOST_AP_RE, "ap", 1.5, "hostname_ap"),
            (_HOST_ROUTER_RE, "router", 1.4, "hostname_router"),
            (_HOST_SWITCH_RE, "switch", 1.4, "hostname_switch"),
            (_HOST_SERVER_RE, "server", 1.5, "hostname_server"),
            (_HOST_NAS_RE, "nas", 1.5, "hostname_nas"),
            (_HOST_VOIP_RE, "voip", 1.5, "hostname_voip"),
            (_HOST_UPS_RE, "ups", 1.5, "hostname_ups"),
            (_HOST_CAM_RE, "camera", 1.5, "hostname_camera"),
        ):
            if regex.search(name):
                scores[key] += weight
                signals.append(sig)

    # Vendor priors
    if vendor in _INFRA_VENDORS:
        scores["unknown"] += 0.4
        signals.append(f"vendor:{vendor}")
        if vendor in {"Fortinet", "Palo Alto"}:
            scores["firewall"] += 1.2
        if vendor == "MikroTik":
            scores["router"] += 0.8
        if vendor in {"Ubiquiti", "Ruckus"}:
            scores["ap"] += 0.5
            scores["switch"] += 0.4
            scores["controller"] += 0.3
        if vendor in {"Synology", "QNAP"}:
            scores["nas"] += 1.5
        if vendor in {"APC", "Eaton"}:
            scores["ups"] += 1.5
        if vendor in {"Hikvision", "Dahua", "Axis"}:
            scores["camera"] += 1.5
        if vendor in {"Yealink", "Grandstream"}:
            scores["voip"] += 1.5
        if vendor == "VMware":
            scores["server"] += 1.5

    # Deep poll hints
    if hints.wifi_ports >= 1:
        scores["ap"] += 2.0 + min(hints.wifi_ports, 4) * 0.3
        signals.append(f"wifi_ifaces:{hints.wifi_ports}")
    if hints.ethernet_ports >= 8:
        scores["switch"] += 1.8 + min(hints.ethernet_ports / 24.0, 1.5)
        signals.append(f"eth_ports:{hints.ethernet_ports}")
    elif hints.ethernet_ports >= 4:
        scores["switch"] += 0.8
        signals.append(f"eth_ports:{hints.ethernet_ports}")
    if hints.has_bridge_fdb or hints.fdb_entries >= 5:
        scores["switch"] += 1.6
        signals.append(f"bridge_fdb:{hints.fdb_entries}")
    if hints.ip_forwarding is True:
        scores["router"] += 2.2
        signals.append("ip_forwarding")
        if hints.ethernet_ports >= 12 or hints.has_bridge_fdb:
            scores["switch"] += 1.0
            signals.append("l3_switch_candidate")
    if hints.ip_forwarding is False and hints.ethernet_ports >= 8:
        scores["switch"] += 0.8
        signals.append("l2_only")
    if hints.neighbor_count >= 1:
        scores["switch"] += 0.4
        scores["router"] += 0.3
        signals.append(f"neighbors:{hints.neighbor_count}")

    for regex, key, sig in (
        (_SWITCH_RE, "switch", "entity_switch"),
        (_ROUTER_RE, "router", "entity_router"),
        (_AP_RE, "ap", "entity_ap"),
        (_FIREWALL_RE, "firewall", "entity_firewall"),
        (_NAS_RE, "nas", "entity_nas"),
        (_UPS_RE, "ups", "entity_ups"),
        (_CAMERA_RE, "camera", "entity_camera"),
        (_SERVER_RE, "server", "entity_server"),
    ):
        if entity_blob and regex.search(entity_blob):
            scores[key] += 1.2
            signals.append(sig)

    gear_score = max(scores[k] for k in _GEAR_TYPES)

    # Pure workstations — skip (PCs live in Computers inventory)
    if _WORKSTATION_RE.search(full) and gear_score < 1.5 and scores["server"] < 1.5:
        return DeviceClassification("host", vendor, False, 0.85, model, ("workstation_os",))

    best_type = max(scores.keys(), key=lambda k: scores[k])
    best_score = scores[best_type]

    if best_type == "unknown" or best_score < 1.0:
        if vendor in _NETWORK_VENDORS:
            if hints.wifi_ports and hints.wifi_ports >= hints.ethernet_ports:
                best_type, best_score = "ap", max(best_score, 1.5)
            elif hints.has_bridge_fdb or hints.ethernet_ports >= 8:
                best_type, best_score = "switch", max(best_score, 1.5)
            elif hints.ip_forwarding:
                best_type, best_score = "router", max(best_score, 1.5)
            else:
                best_type = "unknown"
                best_score = max(best_score, 0.7)
            signals.append("vendor_fallback")
        elif vendor in _INFRA_VENDORS:
            best_type = "unknown"
            best_score = max(best_score, 0.75)
            signals.append("infra_vendor")
        elif (sys_descr or "").strip() or hints.ethernet_ports or hints.has_bridge_fdb:
            best_type = "unknown"
            best_score = max(best_score, 0.55)
            signals.append("snmp_responder")
        else:
            return DeviceClassification("unknown", vendor, False, 0.0, model, tuple(signals))

    # L3 switch: high switch + router → keep switch
    if best_type == "router" and scores["switch"] >= 2.5 and scores["router"] - scores["switch"] < 0.8:
        if hints.ethernet_ports >= 12 or hints.has_bridge_fdb:
            best_type = "switch"
            signals.append("prefer_l3_switch")
            best_score = max(best_score, scores["switch"])

    # Controller beats generic AP wording when both match
    if best_type == "ap" and scores["controller"] >= scores["ap"]:
        best_type = "controller"
        best_score = scores["controller"]
        signals.append("prefer_controller")

    confidence = min(0.99, best_score / 5.0)
    is_gear = best_type not in {"printer", "host"}
    if is_gear and confidence < 0.35 and vendor not in _INFRA_VENDORS and not hints.has_bridge_fdb:
        is_gear = bool((sys_descr or "").strip())

    if best_type not in NETWORK_DEVICE_TYPES and best_type not in {"printer", "host"}:
        best_type = "unknown"

    return DeviceClassification(
        device_type=best_type if is_gear or best_type in {"printer", "host"} else "unknown",
        vendor=vendor,
        is_network_gear=is_gear and best_type not in {"printer", "host"},
        confidence=confidence,
        model=(model or None),
        signals=tuple(signals[:24]),
    )


def build_hints_from_interfaces(
    interfaces: list[Any],
    *,
    fdb_count: int = 0,
    neighbor_count: int = 0,
    ip_forwarding: bool | None = None,
    entity_model: str | None = None,
    entity_serial: str | None = None,
    entity_descr: str | None = None,
) -> ClassifyHints:
    eth = 0
    wifi = 0
    up = 0
    for iface in interfaces:
        itype = getattr(iface, "if_type", None)
        if isinstance(iface, dict):
            itype = iface.get("if_type")
            oper = iface.get("oper_status")
        else:
            oper = getattr(iface, "oper_status", None)
        try:
            itype_i = int(itype) if itype is not None else None
        except (TypeError, ValueError):
            itype_i = None
        if itype_i in _IFTYPE_WIFI:
            wifi += 1
        elif itype_i in _IFTYPE_ETHERNET or itype_i in {6, 62, 69, 117, 55}:
            eth += 1
        elif itype_i is None:
            name = ""
            if isinstance(iface, dict):
                name = str(iface.get("name") or iface.get("descr") or "")
            else:
                name = str(getattr(iface, "name", None) or getattr(iface, "descr", None) or "")
            if re.search(r"\b(gi|fa|te|eth|ethernet|ge-|xe-|sfp)\b", name, re.I):
                eth += 1
            if re.search(r"\b(wlan|wifi|radio|ath|wl)\b", name, re.I):
                wifi += 1
        if oper == "up":
            up += 1
    return ClassifyHints(
        ethernet_ports=eth,
        wifi_ports=wifi,
        ports_up=up,
        has_bridge_fdb=fdb_count > 0,
        fdb_entries=fdb_count,
        ip_forwarding=ip_forwarding,
        neighbor_count=neighbor_count,
        entity_model=entity_model,
        entity_serial=entity_serial,
        entity_descr=entity_descr,
    )


def _extract_model(blob: str) -> str | None:
    m = _MODEL_RE.search(blob or "")
    if m:
        return m.group(1).strip()[:128]
    m2 = re.search(r"\b([A-Z]?\d{3,5}[A-Z]\s+\d{3,4}[A-Z]?-\d{1,3}[A-Z]?)\b", blob or "", re.I)
    if m2:
        return m2.group(1).strip()[:128]
    return None


def _vendor_from_text(blob: str) -> str | None:
    for pattern, name in _VENDOR_PATTERNS:
        if pattern.search(blob):
            return name
    return None


def _vendor_from_oid(sys_object_id: str | None) -> str | None:
    oid = (sys_object_id or "").strip()
    if not oid:
        return None
    if not oid.startswith("1."):
        oid = oid.lstrip(".")
    for prefix, name in _OID_VENDOR:
        if oid.startswith(prefix) or oid.startswith(prefix.rstrip(".")):
            return name
    return None


def normalize_mac(raw: str | bytes | None) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, bytes):
        if len(raw) == 6:
            return ":".join(f"{b:02x}" for b in raw)
        try:
            raw = raw.decode("latin-1", errors="ignore")
        except Exception:
            return None
    s = str(raw).strip().lower()
    if not s:
        return None
    hex_only = re.sub(r"[^0-9a-f]", "", s)
    if len(hex_only) == 12:
        return ":".join(hex_only[i : i + 2] for i in range(0, 12, 2))
    return None


def network_dedupe_key_for_ip(ip: str) -> str:
    return f"snmp:{ip.strip()}"


def infer_network_role(
    *,
    hostname: str | None,
    sys_name: str | None = None,
    device_type: str | None = None,
    source: str | None = None,
) -> str:
    """
    UI role label derived from stored name/type/source (no secrets).
    Special roles: gateway, dns, infra — otherwise device_type.
    """
    blob = f"{hostname or ''} {sys_name or ''}".strip().lower()
    src = (source or "").strip().lower()
    if blob.startswith("gateway") or re.search(r"\bgateway\b", blob):
        return "gateway"
    if blob.startswith("dns") or re.search(r"\bdns\b", blob):
        return "dns"
    if blob.startswith("infra") or (src == "arp-seed" and (device_type or "") == "unknown"):
        return "infra"
    dtype = (device_type or "unknown").strip().lower()
    if dtype in NETWORK_DEVICE_TYPES:
        return dtype
    return "unknown"
