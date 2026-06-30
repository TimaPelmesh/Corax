from __future__ import annotations

import json
import re
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Computer, Peripheral, Printer
from app.printer_sync import extract_ip_from_port, printer_dedupe_key
from app.schemas import AgentPrinterItem

_NOISE_RE = re.compile(
    r"microsoft\s+print\s+to\s+pdf|xps\s+document\s+writer|onenote|^fax$|send\s+to\s+onenote|pdf",
    re.I,
)


def is_noise_printer_name(name: str) -> bool:
    s = (name or "").strip()
    if not s:
        return True
    return bool(_NOISE_RE.search(s))


@dataclass
class FleetSyncResult:
    created: int = 0
    updated: int = 0
    from_peripherals: int = 0
    from_payload: int = 0
    ips_backfilled: int = 0
    total_in_db: int = 0
    with_ip: int = 0
    without_ip: int = 0


@dataclass
class FleetDiscoverySummary:
    printers_in_db: int
    with_ip: int
    without_ip: int
    peripheral_candidates: int
    payload_printer_entries: int
    computers_reported: int


async def _upsert_printer_row(
    db: AsyncSession,
    *,
    computer_id: int,
    name: str,
    driver_name: str | None = None,
    port_name: str | None = None,
    ip: str | None = None,
    is_network: bool = False,
    is_shared: bool = False,
    is_default: bool = False,
    agent_status: str | None = None,
    work_offline: bool | None = None,
    seen_at,
    result: FleetSyncResult,
) -> None:
    item = AgentPrinterItem(
        name=name,
        driver_name=driver_name,
        port_name=port_name,
        shared=is_shared,
        is_default=is_default,
        is_network=is_network or bool(ip),
        ip_address=ip,
        status_label=agent_status,
        work_offline=work_offline,
    )
    dedupe_key, ip_resolved, is_net = printer_dedupe_key(item, computer_id)
    row = (await db.execute(select(Printer).where(Printer.dedupe_key == dedupe_key).limit(1))).scalar_one_or_none()
    if row is None:
        row = Printer(dedupe_key=dedupe_key, name=name[:512], source="agent")
        db.add(row)
        result.created += 1
    else:
        result.updated += 1
    row.name = name[:512]
    row.driver_name = (driver_name or "").strip()[:512] or row.driver_name
    row.port_name = (port_name or "").strip()[:512] or row.port_name
    row.ip_address = ip_resolved or row.ip_address
    row.is_network = is_net
    row.is_shared = bool(is_shared)
    row.is_default = bool(is_default)
    row.agent_status = agent_status or row.agent_status
    row.work_offline = work_offline if work_offline is not None else row.work_offline
    row.computer_id = computer_id
    row.last_seen_at = seen_at
    if row.source != "manual":
        row.source = "agent"


async def backfill_printer_ips(db: AsyncSession, result: FleetSyncResult) -> None:
    rows = (await db.execute(select(Printer))).scalars().all()
    for row in rows:
        if (row.ip_address or "").strip():
            continue
        ip = extract_ip_from_port(row.port_name)
        if ip:
            row.ip_address = ip
            row.is_network = True
            result.ips_backfilled += 1


async def count_fleet_discovery(db: AsyncSession) -> FleetDiscoverySummary:
    printers_in_db = int(await db.scalar(select(func.count()).select_from(Printer)) or 0)
    with_ip = int(
        await db.scalar(
            select(func.count()).select_from(Printer).where(Printer.ip_address.is_not(None), Printer.ip_address != "")
        )
        or 0
    )
    peripheral_candidates = int(
        await db.scalar(select(func.count()).select_from(Peripheral).where(Peripheral.kind == "printer"))
        or 0
    )
    payload_entries = 0
    computers_reported = 0
    pcs = (await db.execute(select(Computer).where(Computer.raw_payload.is_not(None)))).scalars().all()
    for pc in pcs:
        try:
            data = json.loads(pc.raw_payload or "")
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        arr = data.get("printers")
        if isinstance(arr, list) and arr:
            computers_reported += 1
            payload_entries += len(arr)
    return FleetDiscoverySummary(
        printers_in_db=printers_in_db,
        with_ip=with_ip,
        without_ip=max(0, printers_in_db - with_ip),
        peripheral_candidates=peripheral_candidates,
        payload_printer_entries=payload_entries,
        computers_reported=computers_reported,
    )


async def sync_printers_from_fleet(db: AsyncSession) -> FleetSyncResult:
    from datetime import datetime, timezone

    result = FleetSyncResult()
    now = datetime.now(timezone.utc)

    periph_rows = (
        await db.execute(
            select(Peripheral, Computer)
            .join(Computer, Computer.id == Peripheral.computer_id)
            .where(Peripheral.kind == "printer")
            .order_by(Peripheral.id.asc())
        )
    ).all()
    for periph, pc in periph_rows:
        name = (periph.name or "").strip()
        if is_noise_printer_name(name):
            continue
        result.from_peripherals += 1
        await _upsert_printer_row(
            db,
            computer_id=pc.id,
            name=name,
            seen_at=pc.last_report_at or now,
            result=result,
        )

    pcs = (await db.execute(select(Computer).where(Computer.raw_payload.is_not(None)))).scalars().all()
    for pc in pcs:
        try:
            data = json.loads(pc.raw_payload or "")
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        arr = data.get("printers")
        if not isinstance(arr, list):
            continue
        for raw in arr:
            if not isinstance(raw, dict):
                continue
            name = str(raw.get("name") or "").strip()
            if is_noise_printer_name(name):
                continue
            result.from_payload += 1
            await _upsert_printer_row(
                db,
                computer_id=pc.id,
                name=name,
                driver_name=raw.get("driver_name"),
                port_name=raw.get("port_name"),
                ip=(raw.get("ip_address") or None),
                is_network=bool(raw.get("is_network")),
                is_shared=bool(raw.get("shared")),
                is_default=bool(raw.get("is_default")),
                agent_status=raw.get("status_label"),
                work_offline=raw.get("work_offline"),
                seen_at=pc.last_report_at or now,
                result=result,
            )

    await backfill_printer_ips(db, result)
    await db.flush()

    summary = await count_fleet_discovery(db)
    result.total_in_db = summary.printers_in_db
    result.with_ip = summary.with_ip
    result.without_ip = summary.without_ip
    await db.commit()
    return result
