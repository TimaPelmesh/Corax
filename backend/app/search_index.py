"""Deterministic PostgreSQL search projection for catalog entities."""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Computer, InstalledSoftware, Monitor, NetworkDevice, Printer, ServiceRequest
from app.warehouse_models import StockItem

SEARCH_ENTITY_TYPES = frozenset(
    {"computer", "software", "service_request", "printer", "network_device", "monitor", "stock_item"}
)


def _text(*values: object | None) -> str:
    return " ".join(str(value).strip() for value in values if value is not None and str(value).strip())


def _metadata(**values: object | None) -> dict[str, object]:
    return {key: value for key, value in values.items() if value is not None and value != ""}


async def upsert_search_document(
    db: AsyncSession,
    *,
    entity_type: str,
    entity_id: int,
    title: str,
    body: str = "",
    identifiers: str = "",
    metadata: dict[str, object] | None = None,
) -> None:
    """Insert or replace one search projection; caller owns the transaction."""
    if entity_type not in SEARCH_ENTITY_TYPES:
        raise ValueError(f"Unsupported search entity type: {entity_type}")
    title = title.strip() or f"{entity_type} #{entity_id}"
    body = body.strip()
    identifiers = identifiers.strip()
    indexed_text = _text(title, identifiers, body)
    await db.execute(
        text(
            """
            INSERT INTO search_documents
                (entity_type, entity_id, title, body, identifiers, metadata_json, search_vector, updated_at)
            VALUES
                (:entity_type, :entity_id, :title, :body, :identifiers, CAST(:metadata_json AS jsonb),
                 to_tsvector('russian', :indexed_text), NOW())
            ON CONFLICT (entity_type, entity_id) DO UPDATE SET
                title = EXCLUDED.title,
                body = EXCLUDED.body,
                identifiers = EXCLUDED.identifiers,
                metadata_json = EXCLUDED.metadata_json,
                search_vector = EXCLUDED.search_vector,
                updated_at = NOW()
            """
        ),
        {
            "entity_type": entity_type,
            "entity_id": entity_id,
            "title": title,
            "body": body,
            "identifiers": identifiers,
            "metadata_json": json.dumps(metadata or {}, ensure_ascii=False),
            "indexed_text": indexed_text,
        },
    )


async def delete_search_document(db: AsyncSession, entity_type: str, entity_id: int) -> None:
    await db.execute(
        text("DELETE FROM search_documents WHERE entity_type = :entity_type AND entity_id = :entity_id"),
        {"entity_type": entity_type, "entity_id": entity_id},
    )


async def index_computer(db: AsyncSession, computer: Computer) -> None:
    await upsert_search_document(
        db,
        entity_type="computer",
        entity_id=computer.id,
        title=computer.hostname,
        identifiers=_text(computer.hostname, computer.serial_number, computer.ip_address, computer.mac_primary),
        body=_text(
            computer.location,
            computer.os_name,
            computer.os_version,
            computer.manufacturer,
            computer.model,
            computer.cpu,
            computer.gpu_name,
            computer.notes,
        ),
        metadata=_metadata(
            hostname=computer.hostname,
            serial_number=computer.serial_number,
            ip_address=computer.ip_address,
            location=computer.location,
            api_path=f"/computers/{computer.id}",
        ),
    )


async def index_software(db: AsyncSession, software: InstalledSoftware, hostname: str | None = None) -> None:
    title = _text(software.name, software.version) or f"ПО #{software.id}"
    await upsert_search_document(
        db,
        entity_type="software",
        entity_id=software.id,
        title=title,
        identifiers=_text(software.name, software.version, hostname),
        body=_text("Установлено на", hostname),
        metadata=_metadata(
            computer_id=software.computer_id,
            hostname=hostname,
            software_name=software.name,
            version=software.version,
            api_path=f"/computers/{software.computer_id}/software",
        ),
    )


async def sync_computer(db: AsyncSession, computer: Computer) -> None:
    """Refresh a computer and its software rows after inventory imports or edits."""
    await index_computer(db, computer)
    await db.execute(
        text(
            "DELETE FROM search_documents "
            "WHERE entity_type = 'software' AND metadata_json ->> 'computer_id' = :computer_id"
        ),
        {"computer_id": str(computer.id)},
    )
    rows = (
        await db.execute(select(InstalledSoftware).where(InstalledSoftware.computer_id == computer.id))
    ).scalars().all()
    for software in rows:
        await index_software(db, software, computer.hostname)


async def index_service_request(db: AsyncSession, request: ServiceRequest) -> None:
    await index_service_requests(db, (request,))


async def index_service_requests(db: AsyncSession, requests: Sequence[ServiceRequest]) -> None:
    """Refresh service-request search projections with one executemany call."""
    params: list[dict[str, object]] = []
    for request in requests:
        if request.id is None:
            continue
        ticket = str(request.ticket_no or request.glpi_id or request.id)
        title = _text("Заявка", ticket, request.title)
        body = _text(
            request.title,
            request.description,
            request.status,
            request.priority,
            request.requester_name,
            request.category,
            request.location,
        )
        identifiers = _text(ticket, request.glpi_id, request.external_id)
        params.append(
            {
                "entity_type": "service_request",
                "entity_id": request.id,
                "title": title,
                "body": body,
                "identifiers": identifiers,
                "metadata_json": json.dumps(
                    _metadata(
                        ticket_no=request.ticket_no,
                        glpi_id=request.glpi_id,
                        status=request.status,
                        category=request.category,
                        computer_id=request.computer_id,
                        api_path=f"/service-requests/{request.id}",
                    ),
                    ensure_ascii=False,
                ),
                "indexed_text": _text(title, identifiers, body),
            }
        )
    if not params:
        return
    await db.execute(
        text(
            """
            INSERT INTO search_documents
                (entity_type, entity_id, title, body, identifiers, metadata_json, search_vector, updated_at)
            VALUES
                (:entity_type, :entity_id, :title, :body, :identifiers, CAST(:metadata_json AS jsonb),
                 to_tsvector('russian', :indexed_text), NOW())
            ON CONFLICT (entity_type, entity_id) DO UPDATE SET
                title = EXCLUDED.title,
                body = EXCLUDED.body,
                identifiers = EXCLUDED.identifiers,
                metadata_json = EXCLUDED.metadata_json,
                search_vector = EXCLUDED.search_vector,
                updated_at = NOW()
            """
        ),
        params,
    )


async def _index_rows(db: AsyncSession, rows: Iterable[object]) -> int:
    count = 0
    for row in rows:
        if isinstance(row, Computer):
            await sync_computer(db, row)
        elif isinstance(row, ServiceRequest):
            await index_service_request(db, row)
        elif isinstance(row, Printer):
            await upsert_search_document(
                db, entity_type="printer", entity_id=row.id, title=row.name,
                identifiers=_text(row.name, row.ip_address, row.dedupe_key),
                body=_text(row.driver_name, row.port_name, row.location, row.snmp_model, row.notes),
                metadata=_metadata(ip_address=row.ip_address, location=row.location, api_path=f"/printers/{row.id}"),
            )
        elif isinstance(row, NetworkDevice):
            await upsert_search_document(
                db, entity_type="network_device", entity_id=row.id, title=_text(row.hostname, row.ip_address),
                identifiers=_text(row.hostname, row.ip_address, row.sys_name, row.dedupe_key),
                body=_text(row.sys_descr, row.vendor, row.device_type, row.location, row.notes),
                metadata=_metadata(ip_address=row.ip_address, hostname=row.hostname, api_path=f"/network/devices/{row.id}"),
            )
        elif isinstance(row, Monitor):
            await upsert_search_document(
                db, entity_type="monitor", entity_id=row.id, title=row.name,
                identifiers=_text(row.name, row.serial_number, row.inventory_number),
                body=_text(row.manufacturer, row.model, row.organization, row.glpi_contact_raw),
                metadata=_metadata(serial_number=row.serial_number, inventory_number=row.inventory_number, api_path=f"/monitors/{row.id}"),
            )
        elif isinstance(row, StockItem):
            await upsert_search_document(
                db, entity_type="stock_item", entity_id=row.id, title=row.name,
                identifiers=_text(row.name, row.internal_code, row.serial_number, row.batch_label, row.manufacturer),
                body=_text(row.status, row.condition, row.manufacturer, row.attributes_json, row.notes),
                metadata=_metadata(internal_code=row.internal_code, serial_number=row.serial_number, api_path=f"/warehouse/items/{row.id}"),
            )
        else:
            continue
        count += 1
    return count


async def index_record(db: AsyncSession, row: object) -> bool:
    """Refresh a supported entity after its ordinary CRUD handler changes it."""
    return bool(await _index_rows(db, (row,)))


async def rebuild_search_index(db: AsyncSession) -> dict[str, int]:
    """Rebuild all projections. Use after restores or bulk imports."""
    await db.execute(text("DELETE FROM search_documents"))
    groups: list[tuple[str, object]] = [
        ("computers", Computer),
        ("service_requests", ServiceRequest),
        ("printers", Printer),
        ("network_devices", NetworkDevice),
        ("monitors", Monitor),
    ]
    # The default deployment uses one physical PostgreSQL database. Do not query
    # warehouse tables through the inventory session when an installation splits it.
    if settings.warehouse_database_url.strip() == settings.database_url.strip():
        groups.append(("stock_items", StockItem))
    counts: dict[str, int] = {}
    for name, model in groups:
        rows = (await db.execute(select(model))).scalars().all()
        counts[name] = await _index_rows(db, rows)
    return counts
