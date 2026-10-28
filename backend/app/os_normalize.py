"""Нормализация подписей ОС: короткие ярлыки (Windows 7 Pro, Windows 10 Ent)."""

from __future__ import annotations

import re
from collections import Counter

_UNKNOWN_LABEL = "Неизвестно"

# Длинные редакции (EN + RU) → короткие ярлыки. Порядок важен: сначала более длинные фразы.
_EDITION_SHORT: tuple[tuple[re.Pattern[str], str], ...] = (
    # RU
    (re.compile(r"\bпрофессиональная\s+n\b", re.I), "Pro N"),
    (re.compile(r"\bпрофессиональная\b", re.I), "Pro"),
    (re.compile(r"\bкорпоративная\s+n\b", re.I), "Ent N"),
    (re.compile(r"\bкорпоративная\b", re.I), "Ent"),
    (re.compile(r"\bмаксимальная\b", re.I), "Ult"),
    (re.compile(r"\bдомашняя\s+базовая\s+n\b", re.I), "Home Basic N"),
    (re.compile(r"\bдомашняя\s+базовая\b", re.I), "Home Basic"),
    (re.compile(r"\bдомашняя\s+расширенная\s+n\b", re.I), "Home Prem N"),
    (re.compile(r"\bдомашняя\s+расширенная\b", re.I), "Home Prem"),
    (re.compile(r"\bдомашняя\s+для\s+одного\s+языка\b", re.I), "Home SL"),
    (re.compile(r"\bдомашняя\b", re.I), "Home"),
    (re.compile(r"\bначальная\b", re.I), "Starter"),
    (re.compile(r"\bдля\s+рабочих\s+станций\b", re.I), "Pro WS"),
    (re.compile(r"\bобразовательная\b", re.I), "Edu"),
    # EN long → short
    (re.compile(r"\bprofessional\s+n\b", re.I), "Pro N"),
    (re.compile(r"\bprofessional\b", re.I), "Pro"),
    (re.compile(r"\benterprise\s+n\b", re.I), "Ent N"),
    (re.compile(r"\benterprise\b", re.I), "Ent"),
    (re.compile(r"\bultimate\b", re.I), "Ult"),
    (re.compile(r"\bhome\s+basic\s+n\b", re.I), "Home Basic N"),
    (re.compile(r"\bhome\s+basic\b", re.I), "Home Basic"),
    (re.compile(r"\bhome\s+premium\s+n\b", re.I), "Home Prem N"),
    (re.compile(r"\bhome\s+premium\b", re.I), "Home Prem"),
    (re.compile(r"\bhome\s+single\s+language\b", re.I), "Home SL"),
    (re.compile(r"\bpro\s+for\s+workstations\b", re.I), "Pro WS"),
    (re.compile(r"\beducation\b", re.I), "Edu"),
)

_MS_PREFIX_RE = re.compile(r"^microsoft\s+", re.I)
_SPACE_RE = re.compile(r"\s+")
_WIN10_RE = re.compile(r"\bwindows\s+10\b", re.I)
_WIN11_RE = re.compile(r"\bwindows\s+11\b", re.I)
_SERVER_RE = re.compile(r"server|сервер", re.I)
# First Windows 10 build is 10240. Windows 11 starts at 22000.
_BUILD_RE = re.compile(r"\b(\d{5})\b")


def windows_build_number(version: str | None) -> int | None:
    """Highest Windows build in a version string such as ``10.0.26100 build 26100``."""
    nums = [int(n) for n in _BUILD_RE.findall(version or "") if int(n) >= 10240]
    return max(nums) if nums else None


def correct_windows_11_name(
    name: str | None,
    version: str | None = None,
    *,
    family: str | None = None,
) -> str | None:
    """Registry ProductName stays ``Windows 10`` on Windows 11. The build number does not."""
    raw = (name or "").strip()
    fam = family.strip().lower() if isinstance(family, str) else ""
    if not raw or _SERVER_RE.search(raw) or fam == "server":
        return name
    build = windows_build_number(version)
    is_11 = fam == "win11" or (build is not None and build >= 22000)
    if not is_11 or _WIN11_RE.search(raw):
        return raw
    if not _WIN10_RE.search(raw):
        return raw
    return _WIN10_RE.sub("Windows 11", raw, count=1)


def normalize_os_display(name: str | None) -> str:
    """Короткая каноническая подпись ОС для группировки (БД не меняем)."""
    s = (name or "").strip()
    if not s:
        return _UNKNOWN_LABEL
    s = _MS_PREFIX_RE.sub("", s).strip()
    for pattern, replacement in _EDITION_SHORT:
        s = pattern.sub(replacement, s)
    s = _SPACE_RE.sub(" ", s).strip()
    return s or _UNKNOWN_LABEL


def os_matches_display(raw_name: str | None, display_name: str) -> bool:
    return normalize_os_display(raw_name) == display_name


def aggregate_os_counts(rows: list[tuple[str | None, int]], *, limit: int | None = None) -> list[tuple[str, int]]:
    counter: Counter[str] = Counter()
    for raw_name, count in rows:
        counter[normalize_os_display(raw_name)] += int(count)
    ordered = sorted(counter.items(), key=lambda item: (-item[1], item[0].lower()))
    if limit is not None:
        return ordered[:limit]
    return ordered
