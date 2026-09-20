"""Group installed software into browsers / office suites for the dashboard."""

from __future__ import annotations

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
            r"outlook\s*20(1[3-9]|2[0-4])|powerpoint\s*20(1[3-9]|2[0-4])",
            re.I,
        ),
    ),
)


def _normalize_software_name(name: str) -> str:
    s = name.replace("®", " ").replace("™", " ")
    s = re.sub(r"\(\s*(?:R|TM)\s*\)", " ", s, flags=re.I)
    return re.sub(r"[\s._\-]+", " ", s).strip()


def classify_software_name(name: str | None) -> SoftwareFamily | None:
    s = _normalize_software_name((name or "").strip())
    if not s or _SKIP_RE.search(s):
        return None
    for family, pattern in _FAMILIES:
        if pattern.search(s):
            return family
    return None
