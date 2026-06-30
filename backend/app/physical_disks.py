"""Aggregate physical disk rows from agent reports (v3 physical_disks + v2 logical disks)."""

from __future__ import annotations

import json
from typing import Any

_DISK_SIZE_ANCHORS = [120, 128, 240, 256, 480, 512, 1000, 1024, 2000, 4000]
_MIN_REPORT_DISK_GB = 32


def disk_size_label(gb: float | None) -> str:
    if gb is None or gb <= 0:
        return "неизвестно"
    g = float(gb)
    best = min(_DISK_SIZE_ANCHORS, key=lambda x: abs(x - g))
    if abs(best - g) / max(best, 1) <= 0.12:
        return f"{best} ГБ"
    return f"{int(round(g))} ГБ"


def disk_size_sort_key(label: str) -> tuple[int, int]:
    if label == "неизвестно":
        return (-1, 0)
    if label.endswith(" ГБ"):
        try:
            return (0, int(label.replace(" ГБ", "")))
        except ValueError:
            return (1, 0)
    return (1, 0)


def normalize_media_type(raw: str | None) -> str:
    if raw is None or str(raw).strip() == "":
        return "Неизвестно"
    low = str(raw).strip().lower()
    if low in ("ssd", "4"):
        return "SSD"
    if low in ("hdd", "3"):
        return "HDD"
    if low in ("scm", "5"):
        return "SCM"
    if low in ("unspecified", "0", "unknown", "other"):
        return "Другой"
    if low == "logical":
        return "Том"
    return str(raw).strip()


_MEDIA_ORDER = {"ssd": 0, "hdd": 1, "scm": 2, "другой": 3, "том": 4, "неизвестно": 5}


def media_sort_key(name: str) -> tuple[int, str]:
    return (_MEDIA_ORDER.get(name.lower(), 50), name.lower())


def disk_variant_label(media: str, size_label: str) -> str:
    if media in ("SSD", "HDD", "SCM"):
        if size_label == "неизвестно":
            return media
        return f"{media} {size_label}"
    if media == "Том":
        if size_label == "неизвестно":
            return "Том"
        return f"Том {size_label}"
    if size_label == "неизвестно":
        return "Тип не указан"
    return size_label


def disk_variant_sort_key(name: str) -> tuple[int, int, str]:
    if name == "Тип не указан":
        return (3, -1, name)
    if name == "Том":
        return (4, 0, name)
    if name.startswith("Том "):
        return (4, disk_size_sort_key(name[4:])[1], name.lower())
    parts = name.split(" ", 1)
    media = parts[0] if parts else name
    size_part = parts[1] if len(parts) > 1 else "неизвестно"
    if media in ("SSD", "HDD", "SCM"):
        return (media_sort_key(media)[0], disk_size_sort_key(size_part)[1], name.lower())
    if name.endswith(" ГБ"):
        return (3, disk_size_sort_key(name)[1], name.lower())
    return (media_sort_key(media)[0], disk_size_sort_key(size_part)[1], name.lower())


def physical_disks_from_extended(ext: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not ext:
        return []
    rows = ext.get("physical_disks")
    if not isinstance(rows, list):
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        out.append(row)
    return out


def logical_disks_from_payload(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Agent v2/v3 core payload: logical volumes in top-level ``disks``."""
    disks = data.get("disks")
    if not isinstance(disks, list):
        return []
    out: list[dict[str, Any]] = []
    seen_mounts: set[str] = set()
    for row in disks:
        if not isinstance(row, dict):
            continue
        mount = str(row.get("mount") or "").strip().upper()
        if mount:
            if mount in seen_mounts:
                continue
            seen_mounts.add(mount)
        total = row.get("total_gb")
        if not isinstance(total, (int, float)) or float(total) <= 0:
            continue
        label = row.get("label")
        friendly = mount or (str(label).strip() if label else "Том")
        out.append(
            {
                "friendly_name": friendly,
                "media_type": "logical",
                "size_gb": float(total),
                "mount": mount or None,
            }
        )
    return out


def _row_size_gb(row: dict[str, Any]) -> float | None:
    size_gb = row.get("size_gb")
    if isinstance(size_gb, (int, float)) and float(size_gb) > 0:
        return float(size_gb)
    return None


def filter_report_disk_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop tiny OEM/recovery partitions when the PC also reports full-size disks."""
    if not rows:
        return []
    sizes = [_row_size_gb(row) for row in rows]
    has_large = any(size is not None and size >= _MIN_REPORT_DISK_GB for size in sizes)
    if not has_large:
        return rows
    out: list[dict[str, Any]] = []
    for row in rows:
        size = _row_size_gb(row)
        media_raw = str(row.get("media_type") or "").strip().lower()
        is_minor = media_raw in ("", "unspecified", "0", "unknown", "other", "logical") or row.get("media_type") is None
        if size is not None and size < _MIN_REPORT_DISK_GB and is_minor:
            continue
        out.append(row)
    return out


def disk_rows_from_payload_data(data: dict[str, Any]) -> list[dict[str, Any]]:
    ext = data.get("extended")
    physical = physical_disks_from_extended(ext if isinstance(ext, dict) else None)
    rows = physical if physical else logical_disks_from_payload(data)
    return filter_report_disk_rows(rows)


def disk_rows_from_raw_payload(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict):
        return []
    return disk_rows_from_payload_data(data)


# Backward-compatible alias used by drilldown helpers.
physical_disks_from_raw_payload = disk_rows_from_raw_payload


def aggregate_physical_disks(
    raw_payloads: list[str | None],
) -> tuple[int, dict[str, int], dict[str, int], dict[str, int]]:
    """Return total disks, counts by media, by size, and by media+size variant."""
    by_media: dict[str, int] = {}
    by_size: dict[str, int] = {}
    by_variant: dict[str, int] = {}
    total = 0
    for raw in raw_payloads:
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        for row in disk_rows_from_payload_data(data):
            total += 1
            media = normalize_media_type(row.get("media_type"))
            by_media[media] = by_media.get(media, 0) + 1
            size_label = disk_size_label(_row_size_gb(row))
            by_size[size_label] = by_size.get(size_label, 0) + 1
            variant = disk_variant_label(media, size_label)
            by_variant[variant] = by_variant.get(variant, 0) + 1
    return total, by_media, by_size, by_variant
