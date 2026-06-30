"""Нормализация OEM и модели из WMI для дашборда и приёма отчёта агента."""

from __future__ import annotations

import re
from collections import Counter

_UNKNOWN_LABEL = "Не указано"

# Служебные строки BIOS/WMI, не являющиеся реальным производителем или моделью.
_WMI_PLACEHOLDER_RE = re.compile(
    r"^(system\s+product\s+name|system\s+manufacturer|system\s+model|system\s+version|"
    r"system\s+sku|system\s+serial\s+number|default\s+string|"
    r"to\s+be\s+filled(?:\s+by\s+o\.?e\.?m\.?)?|not\s+specified|not\s+available|"
    r"not\s+applicable|unknown|undefined|invalid|o\.?e\.?m\.?|n/?a|all\s+series|"
    r"type1family0|product\s+name|bad\s+string)$",
    re.I,
)

_SUFFIX_RE = re.compile(
    r",?\s+(incorporated|inc\.?|ltd\.?|limited|corp\.?|corporation|co\.?,?\s*ltd\.?|gmbh|s\.?a\.?|llc)\.?$",
    re.I,
)

_CANONICAL_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"asustek|\basus\b", re.I), "ASUS"),
    (re.compile(r"gigabyte", re.I), "Gigabyte"),
    (re.compile(r"\bdell\b", re.I), "Dell"),
    (re.compile(r"lenovo", re.I), "Lenovo"),
    (re.compile(r"hewlett[-\s]?packard|\bhp\b", re.I), "HP"),
    (re.compile(r"micro[-\s]?star|\bmsi\b", re.I), "MSI"),
    (re.compile(r"\bacer\b", re.I), "Acer"),
    (re.compile(r"\bapple\b", re.I), "Apple"),
    (re.compile(r"intel\s+corp", re.I), "Intel"),
    (re.compile(r"microsoft\s+corporation|azure", re.I), "Microsoft"),
    (re.compile(r"vmware", re.I), "VMware"),
    (re.compile(r"fujitsu", re.I), "Fujitsu"),
    (re.compile(r"samsung", re.I), "Samsung"),
    (re.compile(r"huawei", re.I), "Huawei"),
    (re.compile(r"supermicro", re.I), "Supermicro"),
    (re.compile(r"packard\s+bell", re.I), "Packard Bell"),
    (re.compile(r"toshiba", re.I), "Toshiba"),
    (re.compile(r"sony", re.I), "Sony"),
    (re.compile(r"panasonic", re.I), "Panasonic"),
    (re.compile(r"lg\s+electronics|\blg\b", re.I), "LG"),
    (re.compile(r"razer", re.I), "Razer"),
    (re.compile(r"alienware", re.I), "Dell"),
    (re.compile(r"origin\s+pc", re.I), "Origin PC"),
)


def is_placeholder_wmi_value(value: str | None) -> bool:
    s = (value or "").strip()
    if not s:
        return True
    return bool(_WMI_PLACEHOLDER_RE.match(s))


def is_placeholder_manufacturer(name: str | None) -> bool:
    return is_placeholder_wmi_value(name)


def normalize_manufacturer(name: str | None) -> str | None:
    """Каноническое имя OEM или None для пустых/служебных значений WMI."""
    s = (name or "").strip()
    if not s or is_placeholder_manufacturer(s):
        return None
    for pattern, canonical in _CANONICAL_RULES:
        if pattern.search(s):
            return canonical
    cleaned = _SUFFIX_RE.sub("", s).strip(" ,.")
    if not cleaned or is_placeholder_manufacturer(cleaned):
        return None
    return cleaned


def manufacturer_display_label(name: str | None) -> str:
    return normalize_manufacturer(name) or _UNKNOWN_LABEL


def manufacturer_matches_display(raw_name: str | None, display_name: str) -> bool:
    return manufacturer_display_label(raw_name) == display_name


def aggregate_manufacturer_counts(rows: list[tuple[str | None, int]], *, limit: int | None = None) -> list[tuple[str, int]]:
    counter: Counter[str] = Counter()
    for raw_name, count in rows:
        counter[manufacturer_display_label(raw_name)] += int(count)
    ordered = sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    if limit is not None:
        return ordered[:limit]
    return ordered


def normalize_system_model(name: str | None) -> str | None:
    """Каноническая модель ПК/платы или None для пустых/служебных значений WMI."""
    s = (name or "").strip()
    if not s or is_placeholder_wmi_value(s):
        return None
    cleaned = re.sub(r"\s+", " ", s).strip()
    return cleaned or None


def system_model_display_label(name: str | None) -> str:
    return normalize_system_model(name) or _UNKNOWN_LABEL


def aggregate_system_model_counts(rows: list[tuple[str | None, int]], *, limit: int | None = None) -> list[tuple[str, int]]:
    counter: Counter[str] = Counter()
    for raw_name, count in rows:
        counter[system_model_display_label(raw_name)] += int(count)
    ordered = sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    if limit is not None:
        return ordered[:limit]
    return ordered
