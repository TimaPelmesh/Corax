from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any

from puresnmp import Client, ObjectIdentifier, V2C

OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0"
OID_SYS_NAME = "1.3.6.1.2.1.1.5.0"
OID_SYS_LOCATION = "1.3.6.1.2.1.1.6.0"
OID_PAGE_COUNT = "1.3.6.1.2.1.43.10.2.1.4.1.1"
OID_SUPPLY_DESC = "1.3.6.1.2.1.43.11.1.1.6"
OID_SUPPLY_MAX = "1.3.6.1.2.1.43.11.1.1.8"
OID_SUPPLY_LEVEL = "1.3.6.1.2.1.43.11.1.1.9"
OID_PRT_SERIAL = "1.3.6.1.2.1.43.5.1.1.17.1"
OID_PRT_NAME = "1.3.6.1.2.1.43.5.1.1.16.1"
# Fallback serial (ENTITY-MIB) — часть этикетников не отдаёт prtGeneralSerialNumber.
OID_ENT_SERIAL = "1.3.6.1.2.1.47.1.1.1.1.11.1"

_WASTE_RE = re.compile(r"waste|used|maintenance|kit|drum|fuser|transfer", re.I)
_HP_PID_RE = re.compile(r"\bPID:([^,\r\n]+)", re.I)
_HP_SUPPLY_CODE_RE = re.compile(r"\b(?:HP\s*)?(CE\d{3}[A-Z]|CF\d{3}[A-Z]|W\d{4}[A-Z])\b", re.I)
_HOSTNAME_LIKE_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{5,24}$")
_PRINTER_VENDOR_RE = re.compile(
    r"\b(HP|Hewlett|LaserJet|Konica|Minolta|bizhub|ineo|TOSHIBA|TEC|Canon|Epson|Brother|"
    r"Xerox|Ricoh|Kyocera|Samsung|Zebra|ZTC|TSC|Godex|Datamax|Honeywell|Intermec|Sato|"
    r"Citizen|Dymo|Cab|Argox|Bixolon|Postek)\b",
    re.I,
)

# Label / barcode printers (often no classic toner — ribbon / thermal).
_LABEL_PRINTER_RE = re.compile(
    r"(?:"
    r"\b(?:"
    r"zebra|ztc|zpl|epl|zebra\s*technologies|"
    r"toshiba\s*tec|\btec\b|"
    r"\btsc\b|ttp-|godex|datamax|honeywell\s*pc|intermec|"
    r"sato|citizen\s*cl|dymo\s*label|labelwriter|"
    r"\bcab\b|argox|bixolon|postek|go\s*label|"
    r"barcode|label\s*printer|этикет|термопринтер|термотрансфер|"
    r"thermal\s*transfer|direct\s*thermal|ribbon"
    r")\b|"
    # Серии: ZT410, ZD421, GK420d, B-EX4T1, TC200, TX600…
    r"\b(?:ZT|ZD|GK|GX|ZC)\d{2,4}[A-Z0-9-]*\b|"
    r"\bB-(?:EX|SA|FV|SX)[A-Z0-9-]*\b|"
    r"\b(?:TTP|TC|TX)\d{2,4}[A-Z0-9-]*\b"
    r")",
    re.I,
)
_CLASSIC_TONER_RE = re.compile(
    r"toner|тонер|cartridge|картридж|cyan|magenta|yellow|ink|чернил|голуб|жёлт|желт|пурпур",
    re.I,
)
_RIBBON_SUPPLY_RE = re.compile(r"ribbon|лента|wax|resin|термолент", re.I)

# Toshiba TEC barcode printers (enterprise MIB 1.3.6.1.4.1.1129)
OID_TEC_DEVICE_MODEL = "1.3.6.1.4.1.1129.1.2.1.1.1.2.1"
OID_TEC_RIBBON_LEVEL = "1.3.6.1.4.1.1129.1.2.1.1.1.2.24"
OID_TEC_BATTERY_LEVEL = "1.3.6.1.4.1.1129.1.2.1.1.1.2.33"
OID_TEC_TOTAL_PRINT = "1.3.6.1.4.1.1129.1.2.1.1.3.25"

_HP_SUPPLY_NAMES: dict[str, str] = {
    "CE400A": "Чёрный тонер HP 507A CE400A",
    "CE400X": "Чёрный тонер HP 507X CE400X",
    "CE401A": "Голубой тонер HP 507A CE401A",
    "CE402A": "Жёлтый тонер HP 507A CE402A",
    "CE403A": "Пурпурный тонер HP 507A CE403A",
    "CE254A": "Бункер отработанного тонера HP CE254A",
    "CE484A": "Печь 110V HP CE484A",
    "CE506A": "Печь 220V HP CE506A",
}


@dataclass
class SupplyReading:
    name: str
    level_percent: int | None = None
    level_raw: int | None = None
    max_capacity: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "level_percent": self.level_percent,
            "level_raw": self.level_raw,
            "max_capacity": self.max_capacity,
        }


@dataclass
class SnmpPrinterSnapshot:
    model: str | None = None
    page_count: int | None = None
    supplies: list[SupplyReading] = field(default_factory=list)
    serial_number: str | None = None
    sys_name: str | None = None
    sys_location: str | None = None
    printer_kind: str = "unknown"  # laser | inkjet | label | mfp | unknown
    error: str | None = None


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


def _looks_like_device_hostname(s: str) -> bool:
    s = (s or "").strip()
    if not s or " " in s:
        return False
    if _looks_broken_snmp_text(s):
        return False
    return bool(_HOSTNAME_LIKE_RE.match(s.upper()))


def _first_clean_line(text: str) -> str:
    for line in text.replace("\r", "\n").splitlines():
        s = line.strip()
        if s and not _looks_broken_snmp_text(s):
            return s
    return ""


def _model_label(name: str, descr: str) -> str | None:
    name = (name or "").strip()
    descr = (descr or "").strip()
    m = _HP_PID_RE.search(descr)
    if m:
        pid = m.group(1).strip()
        if pid:
            return pid[:512]
    descr_line = _first_clean_line(descr)
    name_line = _first_clean_line(name)
    if descr_line and _PRINTER_VENDOR_RE.search(descr_line):
        return descr_line[:512]
    if name_line and _PRINTER_VENDOR_RE.search(name_line) and not _looks_like_device_hostname(name_line):
        return name_line[:512]
    if descr_line and _looks_like_device_hostname(name):
        return descr_line[:512]
    if "jetdirect" in descr.lower() and name_line and not _looks_like_device_hostname(name_line):
        return name_line[:512]
    if descr_line and name_line and name_line.lower() not in descr_line.lower():
        return f"{name_line} — {descr_line}"[:512]
    if descr_line:
        return descr_line[:512]
    if name_line and not _looks_like_device_hostname(name_line):
        return name_line[:512]
    if name_line and _looks_like_device_hostname(name_line):
        return f"Сетевой принтер ({name_line})"[:512]
    return None


def _is_toshiba_tec(model: str | None, descr: str, name: str) -> bool:
    blob = f"{model or ''} {descr} {name}".lower()
    return "toshiba" in blob or " tec " in f" {blob} " or "b-ex" in blob or "b-sa" in blob


def _is_label_printer(
    *,
    model: str | None,
    descr: str,
    name: str,
    supplies: list[SupplyReading],
) -> bool:
    """Этикеточные / термо: Zebra, TEC, TSC… Часто без классического тонера — ribbon."""
    blob = f"{model or ''} {descr} {name}"
    if _LABEL_PRINTER_RE.search(blob):
        return True
    if _is_toshiba_tec(model, descr, name):
        return True
    has_toner = any(_CLASSIC_TONER_RE.search(s.name) for s in supplies)
    has_ribbon = any(_RIBBON_SUPPLY_RE.search(s.name) for s in supplies)
    # Ribbon / лента без CMYK-тонера — типичный этикетник.
    if has_ribbon and not has_toner:
        return True
    # Мало SNMP-расходников и нет тонера: часто закрытый MIB этикетника.
    if not has_toner and len(supplies) <= 1:
        if "этикет" in blob.lower() or re.search(r"thermal|barcode|термо", blob, re.I):
            return True
    return False


def _classify_printer_kind(
    *,
    model: str | None,
    descr: str,
    name: str,
    supplies: list[SupplyReading],
) -> str:
    blob = f"{model or ''} {descr} {name}".lower()
    if _is_label_printer(model=model, descr=descr, name=name, supplies=supplies):
        return "label"
    if re.search(r"\b(mfp|multifunction|all[- ]in[- ]one|aio|сканер|copier|копир)\b", blob):
        return "mfp"
    if re.search(r"\b(inkjet|deskjet|officejet|pixma|ecotank|струйн)\b", blob):
        return "inkjet"
    if re.search(r"\b(laser|laserjet|pagewide|лазер)\b", blob):
        return "laser"
    supply_blob = " ".join(s.name for s in supplies).lower()
    if re.search(r"toner|тонер|cartridge", supply_blob):
        return "laser"
    if re.search(r"ink|чернил", supply_blob):
        return "inkjet"
    return "unknown"


async def _apply_toshiba_tec_extras(client: Client, snap: SnmpPrinterSnapshot, timeout: float) -> None:
    try:
        dev_model = await _safe_get(client, OID_TEC_DEVICE_MODEL, timeout)
        if dev_model and not _looks_broken_snmp_text(str(dev_model)):
            line = str(dev_model).strip()
            if line and (not snap.model or _looks_like_device_hostname(snap.model)):
                snap.model = line[:512]
    except Exception:
        pass
    if snap.page_count is None:
        try:
            pc = await _safe_get(client, OID_TEC_TOTAL_PRINT, timeout)
            if pc is not None:
                snap.page_count = int(pc)
        except (TypeError, ValueError):
            pass
    have = {s.name.lower() for s in snap.supplies}
    for oid, label in (
        (OID_TEC_RIBBON_LEVEL, "Лента (ribbon)"),
        (OID_TEC_BATTERY_LEVEL, "Батарея"),
    ):
        if label.lower() in have:
            continue
        try:
            raw = await _safe_get(client, oid, timeout)
            if raw is None:
                continue
            level = int(raw)
            pct = level if 0 <= level <= 100 else _calc_percent(level, 100)
            snap.supplies.append(
                SupplyReading(name=label, level_percent=pct, level_raw=level, max_capacity=100)
            )
        except (TypeError, ValueError):
            continue
    snap.supplies.sort(key=lambda s: s.name.lower())


async def _try_prt_general_name(client: Client, snap: SnmpPrinterSnapshot, timeout: float) -> None:
    if snap.model and not _looks_like_device_hostname(snap.model):
        return
    try:
        val = await _safe_get(client, OID_PRT_NAME, timeout)
        if val and not _looks_broken_snmp_text(str(val)):
            snap.model = str(val).strip()[:512]
    except Exception:
        pass


def _looks_broken_snmp_text(text: str) -> bool:
    s = (text or "").strip()
    if not s:
        return True
    if "SENTINEL_UNINITIALISED" in s or "x690.types" in s:
        return True
    visible = [c for c in s if not c.isspace()]
    if not visible:
        return True
    broken = sum(1 for c in visible if c in "?�")
    return broken / len(visible) > 0.35


def _normalize_supply_name(desc: str) -> str | None:
    desc = (desc or "").strip().strip("\x00")
    if not desc or "SENTINEL_UNINITIALISED" in desc or "x690.types" in desc:
        return None
    codes = [m.upper() for m in _HP_SUPPLY_CODE_RE.findall(desc)]
    if codes:
        known = [_HP_SUPPLY_NAMES[c] for c in codes if c in _HP_SUPPLY_NAMES]
        if known:
            return " / ".join(known)[:255]
        if _looks_broken_snmp_text(desc):
            return " / ".join(f"Расходник HP {c}" for c in codes)[:255]
    if _looks_broken_snmp_text(desc):
        return None
    return desc[:255]


def _index_key(oid_str: str, base_oid: str) -> str | None:
    if not oid_str.startswith(base_oid + "."):
        return None
    suffix = oid_str[len(base_oid) + 1 :]
    return suffix or None


def _calc_percent(level: int | None, max_cap: int | None) -> int | None:
    if level is None:
        return None
    if max_cap is not None and max_cap > 0 and level >= 0:
        return max(0, min(100, int(round(level / max_cap * 100))))
    if 0 <= level <= 100:
        return int(level)
    return None


async def _safe_get(client: Client, oid: str, timeout: float) -> Any:
    async with asyncio.timeout(timeout):
        return _value_to_python(await client.get(ObjectIdentifier(oid)))


async def _walk_oid_map(client: Client, base_oid: str, timeout: float) -> tuple[dict[str, Any], str | None]:
    out: dict[str, Any] = {}
    try:
        async with asyncio.timeout(timeout):
            async for vb in client.walk(ObjectIdentifier(base_oid), errors="ignore"):
                oid_str = _oid_to_str(vb.oid)
                key = _index_key(oid_str, base_oid)
                if key is None:
                    continue
                out[key] = _value_to_python(vb.value)
    except Exception as e:
        return out, _short_error(e)
    return out, None


async def fetch_printer_snmp(
    ip: str,
    *,
    community: str = "public",
    timeout: float = 5.0,
    port: int = 161,
) -> SnmpPrinterSnapshot:
    snap = SnmpPrinterSnapshot()
    client = Client(ip, V2C(community), port=port)
    errors: list[str] = []
    try:
        descr = ""
        name = ""
        try:
            descr = str(await _safe_get(client, OID_SYS_DESCR, timeout) or "").strip()
        except Exception as e:
            errors.append(_short_error(e))
        try:
            name = str(await _safe_get(client, OID_SYS_NAME, timeout) or "").strip()
        except Exception:
            pass
        snap.model = _model_label(name, descr)
        snap.sys_name = name[:255] if name and not _looks_broken_snmp_text(name) else None
        try:
            loc = str(await _safe_get(client, OID_SYS_LOCATION, timeout) or "").strip()
            if loc and not _looks_broken_snmp_text(loc):
                snap.sys_location = loc[:255]
        except Exception:
            pass
        for serial_oid in (OID_PRT_SERIAL, OID_ENT_SERIAL):
            if snap.serial_number:
                break
            try:
                serial = await _safe_get(client, serial_oid, timeout)
                if serial is None:
                    continue
                serial_s = str(serial).strip()
                if serial_s and not _looks_broken_snmp_text(serial_s) and len(serial_s) >= 3:
                    snap.serial_number = serial_s[:128]
            except Exception:
                continue

        try:
            pc = await _safe_get(client, OID_PAGE_COUNT, timeout)
            if pc is not None:
                snap.page_count = int(pc)
        except Exception as e:
            errors.append(_short_error(e))

        (desc_map, desc_err), (max_map, max_err), (level_map, level_err) = await asyncio.gather(
            _walk_oid_map(client, OID_SUPPLY_DESC, timeout),
            _walk_oid_map(client, OID_SUPPLY_MAX, timeout),
            _walk_oid_map(client, OID_SUPPLY_LEVEL, timeout),
        )
        for err in (desc_err, max_err, level_err):
            if err:
                errors.append(err)
        keys = sorted(set(desc_map) | set(max_map) | set(level_map))
        for key in keys:
            desc = str(desc_map.get(key) or "").strip()
            desc = _normalize_supply_name(desc) or ""
            if not desc:
                continue
            if _WASTE_RE.search(desc):
                continue
            max_raw = max_map.get(key)
            level_raw = level_map.get(key)
            try:
                max_cap = int(max_raw) if max_raw is not None else None
            except (TypeError, ValueError):
                max_cap = None
            try:
                level = int(level_raw) if level_raw is not None else None
            except (TypeError, ValueError):
                level = None
            pct = _calc_percent(level, max_cap)
            snap.supplies.append(
                SupplyReading(
                    name=desc,
                    level_percent=pct,
                    level_raw=level,
                    max_capacity=max_cap,
                )
            )
        snap.supplies.sort(key=lambda s: s.name.lower())
        if _is_toshiba_tec(snap.model, descr, name) or _is_label_printer(
            model=snap.model, descr=descr, name=name, supplies=snap.supplies
        ):
            await _apply_toshiba_tec_extras(client, snap, timeout)
        if not snap.model or _looks_like_device_hostname(snap.model or ""):
            await _try_prt_general_name(client, snap, timeout)
        snap.printer_kind = _classify_printer_kind(
            model=snap.model, descr=descr, name=name, supplies=snap.supplies
        )
        if not snap.model and snap.page_count is None and not snap.supplies:
            detail = errors[0] if errors else "нет данных"
            snap.error = f"SNMP: {detail} (проверьте UDP 161, community и SNMP v2c на принтере)"
    except Exception as e:
        snap.error = f"SNMP: {_short_error(e)}"
    return snap


async def probe_printer_snmp(
    ip: str,
    *,
    community: str = "public",
    timeout: float = 1.2,
    port: int = 161,
) -> SnmpPrinterSnapshot:
    """Fast SNMP probe for discovery: only sysDescr/sysName, no MIB walks."""
    snap = SnmpPrinterSnapshot()
    client = Client(ip, V2C(community), port=port)
    try:
        descr = ""
        name = ""
        try:
            descr = str(await _safe_get(client, OID_SYS_DESCR, timeout) or "").strip()
        except Exception as e:
            snap.error = f"SNMP: {_short_error(e)}"
            return snap
        try:
            name = str(await _safe_get(client, OID_SYS_NAME, timeout) or "").strip()
        except Exception:
            pass
        snap.model = _model_label(name, descr)
        snap.sys_name = name[:255] if name and not _looks_broken_snmp_text(name) else None
        snap.printer_kind = _classify_printer_kind(
            model=snap.model, descr=descr, name=name, supplies=[]
        )
    except Exception as e:
        snap.error = f"SNMP: {_short_error(e)}"
    return snap
