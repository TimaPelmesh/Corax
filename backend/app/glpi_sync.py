"""Pull GLPI tickets into CORAX and push CORAX tickets back out."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.glpi_client import (
    GlpiCredentials,
    GlpiOutbound,
    GlpiTicket,
    fetch_tickets,
    glpi_priority_label,
    glpi_status_label,
    normalize_base_url,
    push_tickets,
)
from app.models import GlpiConfig, ServiceRequest
from app.search_index import index_service_requests
from app.service_request_import import ImportRecord, _process_batch

_BATCH = 250
_ERROR_LIMIT = 20
_CONTENT_SAFE = 20_000


@dataclass
class GlpiSyncResult:
    created: int = 0
    updated: int = 0
    skipped: int = 0
    failed: int = 0
    message: str = ""
    errors: list[str] = field(default_factory=list)


def creds_from_row(row: GlpiConfig) -> GlpiCredentials:
    return GlpiCredentials(
        base_url=row.base_url or "",
        api_mode=(row.api_mode or "v2").strip().lower(),
        grant_type=(row.grant_type or "password").strip().lower(),
        client_id=row.client_id or "",
        client_secret=row.client_secret or "",
        username=row.username or "",
        password=row.password or "",
        app_token=row.app_token or "",
        user_token=row.user_token or "",
        verify_tls=bool(row.verify_tls),
    )


def ticket_to_record(row_number: int, ticket: GlpiTicket) -> ImportRecord:
    return ImportRecord(
        row_number=row_number,
        title=ticket.title[:255],
        glpi_id=ticket.glpi_id,
        description=ticket.content,
        status=ticket.status,
        priority=ticket.priority,
        glpi_status=ticket.status_label,
        glpi_priority=ticket.priority_label,
        glpi_updated_at=ticket.updated_at,
        external_source="glpi",
        external_id=str(ticket.glpi_id),
        external_url=ticket.url,
        requester_name=ticket.requester,
        category=ticket.category,
        location=ticket.location,
        opened_at=ticket.opened_at,
        closed_at=ticket.closed_at,
    )


async def import_glpi_tickets(creds: GlpiCredentials, *, created_by_id: int, limit: int) -> GlpiSyncResult:
    tickets = await asyncio.to_thread(fetch_tickets, creds, max(1, min(int(limit), 2000)))
    records = [ticket_to_record(index, ticket) for index, ticket in enumerate(tickets, start=1)]
    created = updated = skipped = 0
    for offset in range(0, len(records), _BATCH):
        batch_created, batch_updated, batch_skipped = await _process_batch(
            records[offset : offset + _BATCH],
            created_by_id,
        )
        created += batch_created
        updated += batch_updated
        skipped += batch_skipped
    return GlpiSyncResult(
        created=created,
        updated=updated,
        skipped=skipped,
        message=(
            f"Импорт из GLPI: создано {created}, обновлено {updated}, "
            f"без изменений {skipped}"
        ),
    )


async def export_glpi_tickets(
    db: AsyncSession,
    creds: GlpiCredentials,
    *,
    limit: int,
    request_ids: list[int] | None = None,
) -> GlpiSyncResult:
    bounded = max(1, min(int(limit), 2000))
    stmt = select(ServiceRequest)
    if request_ids:
        ids = list(dict.fromkeys(int(item) for item in request_ids))[:bounded]
        if not ids:
            return GlpiSyncResult(message="Нет заявок для выгрузки в GLPI")
        stmt = stmt.where(ServiceRequest.id.in_(ids))
    else:
        stmt = stmt.order_by(ServiceRequest.updated_at.desc(), ServiceRequest.id.desc()).limit(bounded)
    rows = list((await db.execute(stmt)).scalars().all())
    if not rows:
        return GlpiSyncResult(message="В CORAX нет заявок для выгрузки в GLPI")

    outbound = [
        GlpiOutbound(
            corax_id=row.id,
            glpi_id=row.glpi_id,
            title=row.title or f"CORAX #{row.id}",
            content=(row.description or "")[:_CONTENT_SAFE],
            status=row.status or "open",
            priority=row.priority or "normal",
        )
        for row in rows
    ]
    results = await asyncio.to_thread(push_tickets, creds, outbound)
    by_id = {row.id: row for row in rows}
    created = updated = failed = 0
    errors: list[str] = []
    now = datetime.now(timezone.utc)
    base = normalize_base_url(creds.base_url)
    for result in results:
        row = by_id.get(result.corax_id)
        if result.action == "failed" or result.glpi_id is None or row is None:
            failed += 1
            if result.error and len(errors) < _ERROR_LIMIT:
                errors.append(f"#{result.corax_id}: {result.error}")
            continue
        row.glpi_id = result.glpi_id
        row.glpi_status = glpi_status_label(row.status)
        row.glpi_priority = glpi_priority_label(row.priority)
        row.glpi_updated_at = now
        row.external_url = f"{base}/front/ticket.form.php?id={result.glpi_id}"[:512]
        if not (row.external_source or "").strip():
            row.external_source = "glpi"
            row.external_id = str(result.glpi_id)
        if result.action == "created":
            created += 1
        else:
            updated += 1
    touched = [
        by_id[result.corax_id]
        for result in results
        if result.action != "failed" and result.glpi_id is not None and result.corax_id in by_id
    ]
    if touched:
        await db.flush()
        await index_service_requests(db, touched)
    await db.commit()
    message = f"Выгрузка в GLPI: создано {created}, обновлено {updated}, ошибок {failed}"
    return GlpiSyncResult(
        created=created,
        updated=updated,
        failed=failed,
        message=message,
        errors=errors,
    )
