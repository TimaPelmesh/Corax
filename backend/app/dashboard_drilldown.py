"""Resolve dashboard chart segments to computer rows with summaries."""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Computer, DiskVolume, InstalledSoftware, Peripheral
from app.oem_normalize import manufacturer_matches_display, system_model_display_label
from app.physical_disks import disk_rows_from_raw_payload, disk_variant_label, disk_size_label, normalize_media_type

_MONITOR_EXCLUDE_TOKENS = (
    "универсальный монитор pnp",
    "generic pnp monitor",
    "nvidia",
    "geforce",
    "radeon",
    "intel graphics",
    "mirror",
    "dameware",
    "remote display",
    "basic display",
)
_SERIAL_SUFFIX_RE = re.compile(r"\s+(SN|S\/N)\s*[:#]?\s*[A-Za-z0-9._\-]+.*$", re.IGNORECASE)
_DRIVE_LETTER_RE = re.compile(r"^[A-Za-z]:$")


def _is_real_monitor_name(name: str) -> bool:
    low = name.strip().lower()
    if not low:
        return False
    return all(token not in low for token in _MONITOR_EXCLUDE_TOKENS)


def _normalize_monitor_name(name: str) -> str:
    base = _SERIAL_SUFFIX_RE.sub("", name).strip()
    return base or name.strip()


def system_model_matches_display(raw_name: str | None, display_name: str) -> bool:
    return system_model_display_label(raw_name) == display_name


def ram_matches_bucket(ram_gb: float | None, label: str) -> bool:
    if label == "неизвестно":
        return ram_gb is None
    if label.endswith(" ГБ"):
        try:
            bucket = int(label.replace(" ГБ", ""))
        except ValueError:
            return False
        if ram_gb is None:
            return False
        return int(round(float(ram_gb))) == bucket
    return False


def physical_disk_variant_matches(raw_payload: str | None, variant_name: str) -> bool:
    for row in disk_rows_from_raw_payload(raw_payload):
        media = normalize_media_type(row.get("media_type"))
        size_gb = row.get("size_gb")
        size_val = float(size_gb) if isinstance(size_gb, (int, float)) else None
        label = disk_variant_label(media, disk_size_label(size_val))
        if label == variant_name:
            return True
    return False


def format_volumes_summary(volumes: list[DiskVolume]) -> str | None:
    parts: list[str] = []
    for vol in sorted(volumes, key=lambda v: str(v.mount or "")):
        mount = (vol.mount or "").strip()
        if not mount or not _DRIVE_LETTER_RE.match(mount):
            continue
        if vol.used_percent is not None:
            parts.append(f"{mount} {int(round(vol.used_percent))}%")
        elif vol.total_gb is not None:
            parts.append(f"{mount} {int(round(vol.total_gb))} ГБ")
        else:
            parts.append(mount)
    return " · ".join(parts) if parts else None


def format_physical_disks_summary(raw_payload: str | None) -> str | None:
    parts: list[str] = []
    for row in disk_rows_from_raw_payload(raw_payload):
        media = normalize_media_type(row.get("media_type"))
        size_gb = row.get("size_gb")
        size_val = float(size_gb) if isinstance(size_gb, (int, float)) else None
        parts.append(disk_variant_label(media, disk_size_label(size_val)))
    return " · ".join(parts) if parts else None


def computer_matches_segment(
    c: Computer,
    *,
    kind: str,
    name: str,
    monitor_names: set[str] | None = None,
) -> bool:
    if kind == "os":
        os_name = (c.os_name or "").strip() or "Неизвестно"
        return os_name == name
    if kind == "manufacturer":
        return manufacturer_matches_display(c.manufacturer, name)
    if kind == "system_model":
        return system_model_matches_display(c.model, name)
    if kind == "ram":
        return ram_matches_bucket(c.ram_gb, name)
    if kind == "cpu":
        return (c.cpu or "").strip() == name
    if kind == "monitor":
        return bool(monitor_names and name in monitor_names)
    if kind == "physical_disk":
        return physical_disk_variant_matches(c.raw_payload, name)
    if kind == "hostname":
        return c.hostname == name
    return False


async def _monitor_names_for_computer(db: AsyncSession, computer_id: int) -> set[str]:
    r = await db.execute(
        select(Peripheral.name)
        .where(Peripheral.computer_id == computer_id)
        .where(Peripheral.kind == "monitor")
        .where(Peripheral.name.is_not(None))
        .where(Peripheral.name != "")
    )
    out: set[str] = set()
    for row in r.all():
        raw_name = str(row[0]).strip()
        if not _is_real_monitor_name(raw_name):
            continue
        out.add(_normalize_monitor_name(raw_name))
    return out


async def fetch_segment_computers(
    db: AsyncSession,
    *,
    kind: str,
    name: str,
    limit: int = 200,
) -> tuple[list[Computer], int]:
    name = name.strip()
    if not name:
        return [], 0

    if kind == "software":
        r = await db.execute(
            select(Computer)
            .join(InstalledSoftware, InstalledSoftware.computer_id == Computer.id)
            .where(InstalledSoftware.name == name)
            .order_by(Computer.hostname.asc())
            .limit(limit)
        )
        items = list(r.scalars().unique().all())
        total = int(
            await db.scalar(
                select(func.count(func.distinct(Computer.id)))
                .select_from(Computer)
                .join(InstalledSoftware, InstalledSoftware.computer_id == Computer.id)
                .where(InstalledSoftware.name == name)
            )
            or 0
        )
        return items, total

    if kind == "peripheral":
        r = await db.execute(
            select(Computer)
            .join(Peripheral, Peripheral.computer_id == Computer.id)
            .where(Peripheral.name == name)
            .order_by(Computer.hostname.asc())
            .limit(limit)
        )
        items = list(r.scalars().unique().all())
        total = int(
            await db.scalar(
                select(func.count(func.distinct(Computer.id)))
                .select_from(Computer)
                .join(Peripheral, Peripheral.computer_id == Computer.id)
                .where(Peripheral.name == name)
            )
            or 0
        )
        return items, total

    if kind == "peripheral_kind":
        r = await db.execute(
            select(Computer)
            .join(Peripheral, Peripheral.computer_id == Computer.id)
            .where(Peripheral.kind == name)
            .order_by(Computer.hostname.asc())
            .limit(limit)
        )
        items = list(r.scalars().unique().all())
        total = int(
            await db.scalar(
                select(func.count(func.distinct(Computer.id)))
                .select_from(Computer)
                .join(Peripheral, Peripheral.computer_id == Computer.id)
                .where(Peripheral.kind == name)
            )
            or 0
        )
        return items, total

    if kind == "hostname":
        r = await db.execute(select(Computer).where(Computer.hostname == name).limit(1))
        item = r.scalar_one_or_none()
        return ([item], 1) if item else ([], 0)

    r = await db.execute(select(Computer).order_by(Computer.hostname.asc()))
    all_pcs = list(r.scalars().all())

    if kind == "monitor":
        matched: list[Computer] = []
        for pc in all_pcs:
            names = await _monitor_names_for_computer(db, pc.id)
            if name in names:
                matched.append(pc)
        total = len(matched)
        return matched[:limit], total

    matched = [pc for pc in all_pcs if computer_matches_segment(pc, kind=kind, name=name)]
    total = len(matched)
    return matched[:limit], total


async def volumes_by_computer(db: AsyncSession, computer_ids: list[int]) -> dict[int, list[DiskVolume]]:
    if not computer_ids:
        return {}
    r = await db.execute(select(DiskVolume).where(DiskVolume.computer_id.in_(computer_ids)))
    out: dict[int, list[DiskVolume]] = {cid: [] for cid in computer_ids}
    for vol in r.scalars().all():
        out.setdefault(vol.computer_id, []).append(vol)
    return out


def build_segment_computer_row(
    c: Computer,
    volumes: list[DiskVolume],
) -> dict[str, Any]:
    os_bits = [x for x in [(c.os_name or "").strip(), (c.os_version or "").strip()] if x]
    return {
        "id": c.id,
        "hostname": c.hostname,
        "os_name": c.os_name,
        "os_version": c.os_version,
        "os_summary": " ".join(os_bits) if os_bits else None,
        "ram_gb": c.ram_gb,
        "cpu": c.cpu,
        "manufacturer": c.manufacturer,
        "model": c.model,
        "location": c.location,
        "volumes_summary": format_volumes_summary(volumes),
        "physical_disks_summary": format_physical_disks_summary(c.raw_payload),
    }
