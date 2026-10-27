"""Group installed software into browsers / office suites for the dashboard."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class SoftwareFamily:
    category: str  # browser | office
    name: str


_SKIP_RE = re.compile(
    r"remote\s*desktop|updater|update\s*helper|cleanup|webview|clickonce|"
    r"language\s*pack|proofing|mso\s*cache|edge\s*update|chrome\s*update",
    re.I,
)

# First match wins. More specific patterns first.
_FAMILIES: tuple[tuple[SoftwareFamily, re.Pattern[str]], ...] = (
    (
        SoftwareFamily("browser", "Google Chrome"),
        re.compile(r"google\s*chrome(?!\s*remote)", re.I),
    ),
    (
        SoftwareFamily("browser", "Yandex Browser"),
        re.compile(r"yandex\s*(browser|браузер)|яндекс\s*браузер|\bbrowser\s*yandex", re.I),
    ),
    (
        SoftwareFamily("browser", "Mozilla Firefox"),
        re.compile(r"mozilla\s*firefox|\bfirefox\b", re.I),
    ),
    (
        SoftwareFamily("browser", "Microsoft Edge"),
        re.compile(r"microsoft\s*edge|(?<!google\s)(?<!chromium\s)\bedge\b(?!\s*update)", re.I),
    ),
    (SoftwareFamily("browser", "Opera"), re.compile(r"\bopera\b(?!\s*gx\s*update)", re.I)),
    (SoftwareFamily("browser", "Brave"), re.compile(r"\bbrave\b", re.I)),
    (SoftwareFamily("browser", "Vivaldi"), re.compile(r"\bvivaldi\b", re.I)),
    (SoftwareFamily("browser", "Chromium"), re.compile(r"\bchromium\b", re.I)),
    (
        SoftwareFamily("browser", "Internet Explorer"),
        re.compile(r"internet\s*explorer|\bie\s*11\b", re.I),
    ),
    (
        SoftwareFamily("office", "LibreOffice"),
        re.compile(r"libreoffice", re.I),
    ),
    (
        SoftwareFamily("office", "OnlyOffice"),
        re.compile(r"onlyoffice|only\s*office", re.I),
    ),
    (
        SoftwareFamily("office", "МойОфис"),
        re.compile(r"мойофис|мой\s*офис|myoffice", re.I),
    ),
    (
        SoftwareFamily("office", "Р7-Офис"),
        re.compile(r"р7[\s\-]*офис|r7[\s\-]*office", re.I),
    ),
    (
        SoftwareFamily("office", "OpenOffice"),
        re.compile(r"openoffice", re.I),
    ),
    (
        SoftwareFamily("office", "Microsoft Office"),
        re.compile(
            r"microsoft\s*365|office\s*365|microsoft\s*office|"
            r"office\s*1[6-9]|office\s*20(0[7-9]|1[0-9]|2[0-4])|"
            r"microsoft\s*(word|excel|outlook|powerpoint|access|publisher|onenote)\b|"
            r"word\s*20(1[3-9]|2[0-4])|excel\s*20(1[3-9]|2[0-4])|"
            r"outlook\s*20(1[3-9]|2[0-4])|powerpoint\s*20(1[3-9]|2[0-4])|"
            r"proplus20|standard20|o365",
            re.I,
        ),
    ),
)

_OFFICE_PRODUCT_YEAR = re.compile(
    r"(?:pro\s*plus|proplus|standard|home\s*business|homebusiness|home\s*student|homestudent|mondo|professional)"
    r"\s*(2007|2010|2013|2016|2019|2021|2024)",
    re.I,
)
_OFFICE_YEAR = re.compile(r"\b(2007|2010|2013|2016|2019|2021|2024)\b")
_OFFICE_365 = re.compile(r"microsoft\s*365|office\s*365|\bo365\b|365\s*apps", re.I)


def _normalize_software_name(name: str) -> str:
    s = name.replace("®", " ").replace("™", " ")
    s = re.sub(r"\(\s*(?:R|TM)\s*\)", " ", s, flags=re.I)
    return re.sub(r"[\s._\-]+", " ", s).strip()


def microsoft_office_label(*parts: str | None) -> str:
    """Marketing name: Microsoft Office 2013/2016/2019/2021/2024 or Microsoft 365.

    A bare 16.0 build is shared by 2016, 2019, 2021 and 365, so it stays
    'Microsoft Office' until a year or a 365 name is present.
    """
    text = _normalize_software_name(" ".join(part for part in parts if part))
    if not text:
        return "Microsoft Office"
    product_year = _OFFICE_PRODUCT_YEAR.search(text)
    if product_year:
        return f"Microsoft Office {product_year.group(1)}"
    if _OFFICE_365.search(text) and not re.search(r"20(?:1[3-9]|2[0-4])\s*/\s*365", text):
        return "Microsoft 365"
    year = _OFFICE_YEAR.search(text)
    if year and not re.search(rf"{year.group(1)}\s*/\s*365", text):
        return f"Microsoft Office {year.group(1)}"
    if re.search(r"\b15\.0\b", text):
        return "Microsoft Office 2013"
    if re.search(r"\b14\.0\b", text):
        return "Microsoft Office 2010"
    if re.search(r"\b12\.0\b", text):
        return "Microsoft Office 2007"
    return "Microsoft Office"


def classify_software_name(name: str | None, version: str | None = None) -> SoftwareFamily | None:
    s = _normalize_software_name((name or "").strip())
    if not s or _SKIP_RE.search(s):
        return None
    for family, pattern in _FAMILIES:
        if pattern.search(s) or (version and family.name == "Microsoft Office" and pattern.search(_normalize_software_name(version))):
            if family.name == "Microsoft Office":
                return SoftwareFamily("office", microsoft_office_label(s, version))
            return family
    return None


def office_labels_from_payload(raw: str | None) -> set[str]:
    """Years reported by the agent (ProductReleaseIds live in the install label)."""
    if not raw:
        return set()
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return set()
    extended = data.get("extended") if isinstance(data, dict) else None
    if not isinstance(extended, dict):
        return set()
    installs = extended.get("office_installs")
    if not isinstance(installs, list):
        return set()
    labels: set[str] = set()
    for item in installs:
        if not isinstance(item, dict):
            continue
        labels.add(microsoft_office_label(str(item.get("label") or ""), str(item.get("version") or "")))
    return labels
