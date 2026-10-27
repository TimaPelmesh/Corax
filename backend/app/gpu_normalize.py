"""Pick a real GPU from agent inventory. WMI lists virtual capture/remote adapters first."""

from __future__ import annotations

import re
from typing import Any

_VIRTUAL_RE = re.compile(
    r"basic\s+(display|render)|standard\s+vga|microsoft\s+remote|"
    r"remote\s+display|rdp\s+display|mirror(\s+driver)?|"
    r"virtual\s+(display|desktop|monitor)|indirect\s+display|"
    r"iddsample|orayidd|usbmmidd|idd\s*(adapter|device|driver)|"
    r"displaylink|usb\s*(3\.0\s*)?(vga|display|monitor)|usb\s+mobile\s+monitor|"
    r"spacedesk|parsec|teamviewer|anydesk|tightvnc|ultravnc|realvnc|"
    r"splashtop|rustdesk|todesk|sunlogin|\boray\b|awesun|"
    r"dameware|citrix|nomachine|chrome\s+remote|google\s+remote|"
    r"logmein|gotomypc|connectwise|ammyy|radmin|litemanager|"
    r"aeroadmin|getscreen|supremo|"
    r"steam\s+streaming|sunshine|moonlight|frameview|"
    r"miracast|wireless\s+display|"
    r"nvidia\s+virtual|amd\s+virtual|radeon\s+sharing|"
    r"vnc\s+(server|hook|mirror)|hook\s+driver|"
    r"easy\s+virtual|meta\s+quest|\boculus\b",
    re.I,
)

_DISCRETE_RE = re.compile(
    r"geforce|\brtx\b|\bgtx\b|quadro|tesla|rtx\s*a\d|"
    r"radeon\s+(rx|pro|vii|\d)|firepro|"
    r"\barc\s*a\d|intel\s+arc",
    re.I,
)

_INTEGRATED_RE = re.compile(
    r"iris|uhd\s*graphics|hd\s+graphics|intel\(r\)?\s+graphics|"
    r"intel.*graphics|radeon\s+graphics|vega\s+\d",
    re.I,
)

_VENDOR_RE = re.compile(r"nvidia|geforce|amd|radeon|intel|\barc\b", re.I)


def is_virtual_gpu_name(name: str | None) -> bool:
    text = (name or "").strip()
    if not text:
        return True
    return bool(_VIRTUAL_RE.search(text))


def gpu_score(name: str | None, vram_gb: float | None = None) -> int:
    text = (name or "").strip()
    if not text or is_virtual_gpu_name(text):
        return 0
    score = 15
    if _DISCRETE_RE.search(text):
        score = 100
    elif _INTEGRATED_RE.search(text):
        score = 50
    elif _VENDOR_RE.search(text):
        score = 70
    if isinstance(vram_gb, (int, float)) and vram_gb >= 1:
        score += min(int(vram_gb), 24)
    return score


def _as_vram(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    return None


def _label(name: str | None, processor: str | None) -> str | None:
    n = (name or "").strip()
    p = (processor or "").strip()
    if n and not is_virtual_gpu_name(n):
        return n
    if p and not is_virtual_gpu_name(p):
        return p
    return n or p or None


def _gpu_rows(extended: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(extended, dict):
        return []
    rows = extended.get("gpus")
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def resolve_gpu_name(reported: str | None, extended: dict[str, Any] | None = None) -> str | None:
    """Physical GPU names, discrete first. Virtual remote/capture adapters are dropped."""
    ranked: list[tuple[int, str]] = []
    for row in _gpu_rows(extended):
        label = _label(_as_text(row.get("name")), _as_text(row.get("video_processor")))
        if not label:
            continue
        ranked.append((gpu_score(label, _as_vram(row.get("vram_gb"))), label))
    reported_label = (reported or "").strip() or None
    if reported_label:
        ranked.append((gpu_score(reported_label), reported_label))

    physical = [(score, name) for score, name in ranked if score > 0]
    if not physical:
        return None
    physical.sort(key=lambda item: item[0], reverse=True)
    names: list[str] = []
    seen: set[str] = set()
    for _score, name in physical:
        key = " ".join(name.casefold().split())
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
        if len(names) >= 2:
            break
    return " / ".join(names)[:512] if names else None


def _as_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
