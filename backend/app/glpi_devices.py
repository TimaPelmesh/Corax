"""GLPI monitors and printers: pick every row or only chosen ids.

Rows match by GLPI id, then a unique serial, then a unique inventory number,
then a unique name. An older date_mod does not overwrite a newer stored stamp.
Empty GLPI fields do not wipe filled CORAX values. This module never polls
printers or monitors.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.glpi_client import (
    GlpiCredentials,
    GlpiDevice,
    GlpiDeviceOutbound,
    device_is_stale,
    fetch_devices,
    push_devices,
)
from app.glpi_sync import GlpiSyncResult
from app.models import Computer, Monitor, Printer, User
from app.search_index import index_record

_ERROR_LIMIT = 20


def _clip(value: str | None, limit: int) -> str | None:
    text = " ".join((value or "").split())
    if not text:
        return None
    return text[:limit]


def _key(value: str | None) -> str:
    return " ".join((value or "").split()).casefold()


def _login(contact: str | None) -> str | None:
    text = (contact or "").strip()
    if not text:
        return None
    if "@" in text:
        text = text.split("@", 1)[0].strip()
    return text or None


def _unique(rows: list, predicate) -> object | None:
    found = [row for row in rows if predicate(row)]
    if len(found) > 1:
        raise ValueError("несколько записей с одним ключом")
    return found[0] if found else None


def match_device(rows: list, asset: GlpiDevice):
    if asset.glpi_id:
        found = _unique(rows, lambda row: row.glpi_id == asset.glpi_id)
        if found is not None:
            return found
    for attr, raw in (("serial_number", asset.serial), ("inventory_number", asset.inventory)):
        key = _key(raw)
        if not key:
            continue
        found = _unique(rows, lambda row, attr=attr, key=key: _key(getattr(row, attr)) == key)
        if found is not None:
            return found
    title = _key(asset.name)
    if not title:
        return None
    return _unique(rows, lambda row: _key(row.name) == title)


def _set(row: object, field: str, raw: str | None, limit: int) -> bool:
    text = _clip(raw, limit)
    if text is None or getattr(row, field) == text:
        return False
    setattr(row, field, text)
    return True


def apply_monitor(row: Monitor, asset: GlpiDevice, users: dict[str, int]) -> str:
    if device_is_stale(asset.updated_at, row.glpi_updated_at):
        if row.glpi_id is None:
            row.glpi_id = asset.glpi_id
            return "updated"
        return "skipped"
    changed = row.glpi_id != asset.glpi_id
    row.glpi_id = asset.glpi_id
    changed = _set(row, "name", asset.name, 255) or changed
    changed = _set(row, "manufacturer", asset.manufacturer, 255) or changed
    changed = _set(row, "model", asset.model, 255) or changed
    changed = _set(row, "serial_number", asset.serial, 128) or changed
    changed = _set(row, "inventory_number", asset.inventory, 128) or changed
    changed = _set(row, "organization", asset.organization, 255) or changed
    changed = _set(row, "glpi_contact_raw", asset.contact, 255) or changed
    login = _login(asset.contact)
    user_id = users.get(login.casefold()) if login else None
    if row.assigned_user_id is None and user_id is not None:
        row.assigned_user_id = user_id
        changed = True
    if asset.updated_at is not None and row.glpi_updated_at != asset.updated_at:
        row.glpi_updated_at = asset.updated_at
        changed = True
    return "updated" if changed else "skipped"


def apply_printer(row: Printer, asset: GlpiDevice) -> str:
    if device_is_stale(asset.updated_at, row.glpi_updated_at):
        if row.glpi_id is None:
            row.glpi_id = asset.glpi_id
            return "updated"
        return "skipped"
    changed = row.glpi_id != asset.glpi_id
    row.glpi_id = asset.glpi_id
    changed = _set(row, "name", asset.name, 512) or changed
    changed = _set(row, "serial_number", asset.serial, 128) or changed
    changed = _set(row, "inventory_number", asset.inventory, 128) or changed
    changed = _set(row, "manufacturer", asset.manufacturer, 255) or changed
    changed = _set(row, "glpi_model", asset.model, 255) or changed
    if not row.location_manual:
        changed = _set(row, "location", asset.location, 255) or changed
    changed = _set(row, "notes", asset.comment, 8000) or changed
    if asset.updated_at is not None and row.glpi_updated_at != asset.updated_at:
        row.glpi_updated_at = asset.updated_at
        changed = True
    return "updated" if changed else "skipped"


def _ids(raw: list[int] | None) -> list[int] | None:
    if raw is None:
        return None
    chosen: list[int] = []
    seen: set[int] = set()
    for item in raw:
        number = int(item)
        if number in seen:
            continue
        seen.add(number)
        chosen.append(number)
        if len(chosen) >= 2000:
            break
    return chosen


async def list_local_devices(db: AsyncSession, kind: str, *, limit: int) -> list[dict]:
    bounded = max(1, min(int(limit), 2000))
    if kind == "monitor":
        rows = list(
            (
                await db.scalars(
                    select(Monitor)
                    .options(selectinload(Monitor.assigned_user))
                    .order_by(Monitor.id.desc())
                    .limit(bounded)
                )
            ).all()
        )
        return [_monitor_view(row) for row in rows]
    if kind == "printer":
        rows = list((await db.scalars(select(Printer).order_by(Printer.id.desc()).limit(bounded))).all())
        host_ids = {row.computer_id for row in rows if row.computer_id}
        hosts: dict[int, str] = {}
        if host_ids:
            result = await db.execute(select(Computer.id, Computer.hostname).where(Computer.id.in_(host_ids)))
            hosts = {int(cid): (name or "").strip() for cid, name in result.all()}
        return [_printer_view(row, hosts.get(row.computer_id) if row.computer_id else None) for row in rows]
    raise ValueError("Можно передать только мониторы или принтеры")


def _monitor_view(row: Monitor) -> dict:
    user = row.assigned_user
    assigned = None
    if user is not None:
        assigned = (user.full_name or user.username or "").strip() or None
    group = assigned or row.organization or row.glpi_contact_raw or "Без привязки"
    return {
        "id": row.id,
        "glpi_id": row.glpi_id,
        "name": row.name,
        "serial_number": row.serial_number,
        "inventory_number": row.inventory_number,
        "updated_at": row.glpi_updated_at,
        "kind": "monitor",
        "computer_id": None,
        "computer_hostname": None,
        "ip_address": None,
        "assigned_user": assigned,
        "location": None,
        "group_label": group,
    }


def _printer_view(row: Printer, hostname: str | None = None) -> dict:
    host = (hostname or "").strip() or None
    group = host or (row.ip_address or "").strip() or row.location or "Без привязки"
    return {
        "id": row.id,
        "glpi_id": row.glpi_id,
        "name": row.name,
        "serial_number": row.serial_number,
        "inventory_number": row.inventory_number,
        "updated_at": row.glpi_updated_at,
        "kind": "printer",
        "computer_id": row.computer_id,
        "computer_hostname": host,
        "ip_address": (row.ip_address or "").strip() or None,
        "assigned_user": None,
        "location": row.location,
        "group_label": group,
    }


def _remote_view(asset: GlpiDevice) -> dict:
    group = asset.contact or asset.location or asset.organization or "GLPI"
    return {
        "id": asset.glpi_id,
        "glpi_id": asset.glpi_id,
        "name": asset.name,
        "serial_number": asset.serial,
        "inventory_number": asset.inventory,
        "updated_at": asset.updated_at,
        "kind": None,
        "computer_id": None,
        "computer_hostname": None,
        "ip_address": None,
        "assigned_user": asset.contact,
        "location": asset.location,
        "group_label": group,
    }


async def list_remote_devices(creds: GlpiCredentials, kind: str, *, limit: int) -> list[dict]:
    bounded = max(1, min(int(limit), 2000))
    assets = await asyncio.to_thread(fetch_devices, creds, kind, bounded)
    return [_remote_view(asset) for asset in assets]


async def import_glpi_devices(
    db: AsyncSession,
    creds: GlpiCredentials,
    *,
    kind: str,
    limit: int,
    glpi_ids: list[int] | None,
) -> GlpiSyncResult:
    chosen = _ids(glpi_ids)
    bounded = max(1, min(int(limit), 2000))
    assets = await asyncio.to_thread(
        fetch_devices,
        creds,
        kind,
        bounded if chosen is None else len(chosen),
        glpi_ids=chosen,
    )
    if not assets and not chosen:
        return GlpiSyncResult(message="GLPI не вернул выбранные записи")
    if kind == "monitor":
        result = await _import_monitors(db, assets)
    elif kind == "printer":
        result = await _import_printers(db, assets)
    else:
        raise ValueError("Можно передать только мониторы или принтеры")
    if not chosen:
        return result
    found = {asset.glpi_id for asset in assets}
    missing = [str(item) for item in chosen if item not in found]
    if not missing:
        return result
    errors = list(result.errors)
    if len(errors) < _ERROR_LIMIT:
        errors.append(f"GLPI id не найдены: {', '.join(missing[:_ERROR_LIMIT])}")
    return GlpiSyncResult(
        created=result.created,
        updated=result.updated,
        skipped=result.skipped,
        failed=result.failed + len(missing),
        message=result.message,
        errors=errors,
    )


async def _user_map(db: AsyncSession) -> dict[str, int]:
    users = await db.execute(select(User.id, User.username))
    return {str(name).strip().casefold(): int(uid) for uid, name in users.all() if name}


async def _import_monitors(db: AsyncSession, assets: list[GlpiDevice]) -> GlpiSyncResult:
    rows = list((await db.scalars(select(Monitor))).all())
    users = await _user_map(db)
    created = updated = skipped = failed = 0
    errors: list[str] = []
    touched: list[Monitor] = []
    for asset in assets:
        try:
            async with db.begin_nested():
                match = match_device(rows, asset)
                is_new = match is None
                row = match or Monitor(name=_clip(asset.name, 255) or asset.name[:255])
                if is_new:
                    db.add(row)
                action = apply_monitor(row, asset, users)
                if is_new:
                    rows.append(row)
                    created += 1
                    touched.append(row)
                elif action == "updated":
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
            await index_record(db, row)
    await db.commit()
    return GlpiSyncResult(created=created, updated=updated, skipped=skipped, failed=failed, errors=errors)


async def _import_printers(db: AsyncSession, assets: list[GlpiDevice]) -> GlpiSyncResult:
    rows = list((await db.scalars(select(Printer))).all())
    created = updated = skipped = failed = 0
    errors: list[str] = []
    touched: list[Printer] = []
    for asset in assets:
        try:
            async with db.begin_nested():
                match = match_device(rows, asset)
                is_new = match is None
                if is_new:
                    row = Printer(
                        dedupe_key=f"glpi:{asset.glpi_id}"[:255],
                        name=_clip(asset.name, 512) or asset.name[:512],
                        source="glpi",
                        is_network=False,
                    )
                    db.add(row)
                else:
                    row = match
                action = apply_printer(row, asset)
                if is_new:
                    rows.append(row)
                    created += 1
                    touched.append(row)
                elif action == "updated":
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
            await index_record(db, row)
    await db.commit()
    return GlpiSyncResult(created=created, updated=updated, skipped=skipped, failed=failed, errors=errors)


async def export_glpi_devices(
    db: AsyncSession,
    creds: GlpiCredentials,
    *,
    kind: str,
    limit: int,
    ids: list[int] | None,
) -> GlpiSyncResult:
    chosen = _ids(ids)
    bounded = max(1, min(int(limit), 2000))
    if kind == "monitor":
        stmt = select(Monitor).order_by(Monitor.id.asc())
        if chosen is not None:
            if not chosen:
                return GlpiSyncResult(message="Не выбрано ни одной записи")
            stmt = stmt.where(Monitor.id.in_(chosen))
        else:
            stmt = stmt.limit(bounded)
        rows = list((await db.scalars(stmt)).all())
        outbound = [_monitor_outbound(row) for row in rows if (row.name or "").strip()]
    elif kind == "printer":
        stmt = select(Printer).order_by(Printer.id.asc())
        if chosen is not None:
            if not chosen:
                return GlpiSyncResult(message="Не выбрано ни одной записи")
            stmt = stmt.where(Printer.id.in_(chosen))
        else:
            stmt = stmt.limit(bounded)
        rows = list((await db.scalars(stmt)).all())
        outbound = [_printer_outbound(row) for row in rows if (row.name or "").strip()]
    else:
        raise ValueError("Можно передать только мониторы или принтеры")
    if not outbound:
        return GlpiSyncResult(message="Нечего передавать")
    results = await asyncio.to_thread(push_devices, creds, outbound)
    by_id = {row.id: row for row in rows}
    created = updated = failed = 0
    errors: list[str] = []
    for result in results:
        row = by_id.get(result.corax_id)
        if result.action == "failed" or result.glpi_id is None or row is None:
            failed += 1
            if result.error and len(errors) < _ERROR_LIMIT:
                errors.append(result.error)
            continue
        row.glpi_id = result.glpi_id
        if result.updated_at is not None:
            row.glpi_updated_at = result.updated_at
        if result.action == "created":
            created += 1
        else:
            updated += 1
        await index_record(db, row)
    await db.commit()
    return GlpiSyncResult(created=created, updated=updated, failed=failed, errors=errors)


def _monitor_outbound(row: Monitor) -> GlpiDeviceOutbound:
    return GlpiDeviceOutbound(
        corax_id=row.id,
        kind="monitor",
        name=row.name,
        glpi_id=row.glpi_id,
        serial=row.serial_number,
        inventory=row.inventory_number,
        manufacturer=row.manufacturer,
        model=row.model,
        contact=row.glpi_contact_raw,
    )


def _printer_outbound(row: Printer) -> GlpiDeviceOutbound:
    return GlpiDeviceOutbound(
        corax_id=row.id,
        kind="printer",
        name=row.name,
        glpi_id=row.glpi_id,
        serial=row.serial_number,
        inventory=row.inventory_number,
        manufacturer=row.manufacturer,
        model=row.glpi_model or row.snmp_model,
        location=None if row.location_manual else row.location,
        comment=row.notes,
    )
