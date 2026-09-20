"""Фильтрация и сортировка PnP-периферии для отображения и приёма отчёта агента."""

from __future__ import annotations

import re

_PERIPHERAL_KIND_ORDER: tuple[str, ...] = (
    "monitor",
    "printer",
    "keyboard",
    "mouse",
    "camera",
    "audio",
    "biometric",
    "bluetooth",
    "touchpad",
    "net",
    "other",
)

_MONITOR_EXCLUDE_RE = re.compile(
    r"pnp|nvidia|geforce|amd|radeon|intel\(r\)?.*graphics|display adapter|"
    r"mirror|dameware|remote display|basic display|generic pnp",
    re.I,
)

_PRINTER_NOISE_RE = re.compile(
    r"microsoft\s+print\s+to\s+pdf|xps\s+document\s+writer|onenote|"
    r"^fax$|корневая\s+очередь\s+печати|print queue root",
    re.I,
)

_NET_NOISE_RE = re.compile(
    r"^wan\s+miniport\b|\b(pppoe|pptp|sstp|l2tp|ikev2)\b|"
    r"\b(network\s+monitor|isatap|teredo|6to4)\b|"
    r"\bmicrosoft\s+wi-?fi\s+direct\s+virtual\s+adapter\b|"
    r"\bmicrosoft\s+kernel\s+debug\s+network\s+adapter\b|"
    r"\b(hyper-?v|vmware|virtualbox)\b|\bvirtual\s+(ethernet|switch)\b|"
    r"\b(tap|tunnel|loopback|vpn|wintun)\b",
    re.I,
)


def is_noise_peripheral(kind: str, name: str) -> bool:
    k = (kind or "").strip().lower() or "other"
    n = (name or "").strip()
    if not n:
        return True
    low = n.lower()

    if k == "monitor" and _MONITOR_EXCLUDE_RE.search(low):
        return True
    if k == "printer" and _PRINTER_NOISE_RE.search(low):
        return True
    if k == "net" and _NET_NOISE_RE.search(low):
        return True
    if k in ("keyboard", "mouse") and "dameware" in low:
        return True
    return False


def _kind_sort_key(kind: str) -> tuple[int, str]:
    k = (kind or "other").strip().lower() or "other"
    try:
        return (_PERIPHERAL_KIND_ORDER.index(k), k)
    except ValueError:
        return (len(_PERIPHERAL_KIND_ORDER), k)


def prepare_peripherals_for_display(items: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Дедуп, фильтр шума, сортировка по категории и имени."""
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for kind, name in items:
        k = (kind or "other").strip()[:32] or "other"
        n = (name or "").strip()[:512]
        if not n or is_noise_peripheral(k, n):
            continue
        key = f"{k}|{n.lower()}"
        if key in seen:
            continue
        seen.add(key)
        out.append((k, n))
    out.sort(key=lambda row: (_kind_sort_key(row[0]), row[1].lower()))
    return out
