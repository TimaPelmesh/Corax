"""Pull GLPI computers and installed software into CORAX, and push them back.

Computers match by hostname (case-insensitive), then by a unique serial.
Filled fields overwrite the other side; an empty GLPI field does not wipe a
filled CORAX value. The software set is the name+version identity: the same
pair matches regardless of letter case, and the destination set becomes the
source set. If GLPI does not return a software list, local software is left
alone.

Export modes: all (latest N by hostname) or selected (explicit CORAX computer ids).
IP from CORAX goes into the GLPI computer comment and NetworkPort when possible.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.glpi_client import (
    GlpiComputer,
    GlpiComputerOutbound,
    GlpiCredentials,
    GlpiSoftware,
    canonical_software,
    fetch_computers,
    push_computers,
    software_key,
)
from app.glpi_sync import GlpiSyncResult
from app.models import Computer, InstalledSoftware
from app.search_index import sync_computer

_ERROR_LIMIT = 20


def _key(value: str | None) -> str:
    return " ".join((value or "").split()).casefold()


def _clip(value: str | None, limit: int) -> str | None:
    text = " ".join((value or "").split())
    if not text:
        return None
    return text[:limit]


def _apply_fields(row: Computer, asset: GlpiComputer) -> bool:
    changed = False
    pairs = (
        ("hostname", asset.name, 255),
        ("serial_number", asset.serial, 128),
        ("manufacturer", asset.manufacturer, 255),
        ("model", asset.model, 255),
        ("location", asset.location, 255),
        ("os_name", asset.os_name, 255),
        ("os_version", asset.os_version, 255),
        ("notes", asset.comment, 8000),
    )
    for field, raw, limit in pairs:
        text = _clip(raw, limit)
        if text is None or getattr(row, field) == text:
            continue
        setattr(row, field, text)
        changed = True
    return changed


async def _sync_software(db: AsyncSession, computer: Computer, desired: tuple[GlpiSoftware, ...]) -> bool:
    current = list(
        (
            await db.execute(select(InstalledSoftware).where(InstalledSoftware.computer_id == computer.id))
        ).scalars().all()
    )
    wanted: dict[tuple[str, str], tuple[str, str | None]] = {}
    for item in desired:
        canon = canonical_software(item.name, item.version)
        if canon is not None:
            wanted.setdefault(software_key(*canon), canon)
    changed = False
    seen: set[tuple[str, str]] = set()
    for row in current:
        canon = canonical_software(row.name, row.version)
        if canon is None:
            await db.delete(row)
            changed = True
            continue
        key = software_key(*canon)
        if key not in wanted or key in seen:
            await db.delete(row)
            changed = True
            continue
        seen.add(key)
        name, version = wanted[key]
        if row.name != name or (row.version or None) != version:
            row.name = name
            row.version = version
            changed = True
    for key, (name, version) in wanted.items():
        if key in seen:
            continue
        db.add(InstalledSoftware(computer_id=computer.id, name=name, version=version))
        changed = True
    return changed


def _match_computer(
    by_host: dict[str, Computer],
    by_serial: dict[str, list[Computer]],
    asset: GlpiComputer,
) -> Computer | None:
    host = by_host.get(_key(asset.name))
    if host is not None:
        return host
    serial_key = _key(asset.serial)
    if not serial_key:
        return None
    found = by_serial.get(serial_key) or []
    if len(found) == 1:
        return found[0]
    return None


def _remember(by_host: dict[str, Computer], by_serial: dict[str, list[Computer]], row: Computer) -> None:
    by_host[_key(row.hostname)] = row
    serial_key = _key(row.serial_number)
    if not serial_key:
        return
    bucket = by_serial.setdefault(serial_key, [])
    if row not in bucket:
        bucket.append(row)


async def import_glpi_assets(db: AsyncSession, creds: GlpiCredentials, *, limit: int) -> GlpiSyncResult:
    bounded = max(1, min(int(limit), 2000))
    assets = await asyncio.to_thread(fetch_computers, creds, bounded)
    if not assets:
        return GlpiSyncResult(message="GLPI не вернул компьютеры")

    rows = list((await db.execute(select(Computer))).scalars().all())
    by_host: dict[str, Computer] = {}
    by_serial: dict[str, list[Computer]] = {}
    for row in rows:
        _remember(by_host, by_serial, row)

    created = updated = skipped = failed = 0
    errors: list[str] = []
    touched: list[Computer] = []
    for asset in assets:
        try:
            async with db.begin_nested():
                match = _match_computer(by_host, by_serial, asset)
                is_new = match is None
                row = match or Computer(hostname=_clip(asset.name, 255) or asset.name[:255])
                if is_new:
                    db.add(row)
                    await db.flush()
                field_changed = _apply_fields(row, asset)
                software_changed = False
                if asset.software is not None:
                    software_changed = await _sync_software(db, row, asset.software)
                _remember(by_host, by_serial, row)
                if is_new:
                    created += 1
                    touched.append(row)
                elif field_changed or software_changed:
                    updated += 1
                    touched.append(row)
                else:
                    skipped += 1
        except Exception as exc:
            failed += 1
            if len(errors) < _ERROR_LIMIT:
                errors.append(f"{asset.name}: {exc}")

    if touched:
        await db.flush()
        for row in touched:
            await sync_computer(db, row)
    await db.commit()
    return GlpiSyncResult(
        created=created,
        updated=updated,
        skipped=skipped,
        failed=failed,
        message=(
            f"Импорт ПК из GLPI: создано {created}, обновлено {updated}, "
            f"без изменений {skipped}, ошибок {failed}"
        ),
        errors=errors,
    )


def _outbound(row: Computer, *, skip_software: bool = False) -> GlpiComputerOutbound:
    software: tuple[tuple[str, str | None], ...] | None
    if skip_software:
        software = None
    else:
        seen: set[tuple[str, str]] = set()
        collected: list[tuple[str, str | None]] = []
        for item in row.software:
            canon = canonical_software(item.name, item.version)
            if canon is None:
                continue
            key = software_key(*canon)
            if key in seen:
                continue
            seen.add(key)
            collected.append(canon)
        software = tuple(collected)
    return GlpiComputerOutbound(
        corax_id=row.id,
        hostname=row.hostname,
        serial=row.serial_number,
        manufacturer=row.manufacturer,
        model=row.model,
        location=row.location,
        os_name=row.os_name,
        os_version=row.os_version,
        comment=row.notes,
        ip_address=(row.ip_address or "").strip() or None,
        software=software,
    )


async def list_local_computers(db: AsyncSession, *, limit: int) -> list[dict]:
    """Список ПК CORAX для выбора выгрузки (hostname + IP)."""
    bounded = max(1, min(int(limit), 2000))
    rows = list(
        (
            await db.execute(
                select(Computer).order_by(Computer.hostname).limit(bounded)
            )
        ).scalars().all()
    )
    return [
        {
            "id": row.id,
            "hostname": row.hostname,
            "ip_address": (row.ip_address or "").strip() or None,
            "serial_number": row.serial_number,
            "location": row.location,
        }
        for row in rows
    ]


def _normalize_ids(raw: list[int] | None) -> list[int] | None:
    if raw is None:
        return None
    chosen: list[int] = []
    seen: set[int] = set()
    for item in raw:
        try:
            number = int(item)
        except (TypeError, ValueError):
            continue
        if number <= 0 or number in seen:
            continue
        seen.add(number)
        chosen.append(number)
        if len(chosen) >= 2000:
            break
    return chosen


async def export_glpi_assets(
    db: AsyncSession,
    creds: GlpiCredentials,
    *,
    limit: int,
    computer_ids: list[int] | None = None,
    mode: str = "all",
    skip_software: bool = False,
) -> GlpiSyncResult:
    """Выгрузка ПК (и IP) в GLPI: все в лимите или выбранные id CORAX."""
    bounded = max(1, min(int(limit), 2000))
    export_mode = (mode or "all").strip().lower()
    chosen = _normalize_ids(computer_ids)
    if chosen:
        export_mode = "selected"

    stmt = select(Computer).options(selectinload(Computer.software))
    if export_mode == "selected":
        if not chosen:
            return GlpiSyncResult(message="Укажите id компьютеров CORAX для выборочной выгрузки")
        ids = chosen[:bounded]
        stmt = stmt.where(Computer.id.in_(ids)).order_by(Computer.hostname)
    else:
        stmt = stmt.order_by(Computer.hostname).limit(bounded)

    rows = list((await db.execute(stmt)).scalars().all())
    if not rows:
        empty = (
            "По указанным id компьютеры не найдены"
            if export_mode == "selected"
            else "В CORAX нет компьютеров для выгрузки в GLPI"
        )
        return GlpiSyncResult(message=empty)

    results = await asyncio.to_thread(
        push_computers,
        creds,
        [_outbound(row, skip_software=skip_software) for row in rows],
    )
    created = updated = failed = 0
    errors: list[str] = []
    by_id = {row.id: row for row in rows}
    for result in results:
        host = by_id.get(result.corax_id)
        label = host.hostname if host is not None else str(result.corax_id)
        if result.action == "created":
            created += 1
            if result.error and len(errors) < _ERROR_LIMIT:
                errors.append(f"{label}: {result.error}")
        elif result.action == "updated":
            updated += 1
            if result.error and len(errors) < _ERROR_LIMIT:
                errors.append(f"{label}: {result.error}")
        else:
            failed += 1
            if result.error and len(errors) < _ERROR_LIMIT:
                errors.append(f"{label}: {result.error}")
    mode_label = "выбранные" if export_mode == "selected" else "все в лимите"
    message = (
        f"Выгрузка ПК в GLPI ({mode_label}): создано {created}, "
        f"обновлено {updated}, ошибок {failed}"
    )
    return GlpiSyncResult(created=created, updated=updated, failed=failed, message=message, errors=errors)


__all__ = ["export_glpi_assets", "import_glpi_assets", "list_local_computers"]
