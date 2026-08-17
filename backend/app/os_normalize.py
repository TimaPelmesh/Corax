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
