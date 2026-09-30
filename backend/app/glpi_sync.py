"""Pull GLPI tickets into CORAX and push CORAX tickets back out."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.glpi_client import (
    GlpiCredentials,
    GlpiOutbound,
    GlpiPushResult,
    GlpiTicket,
    fetch_tickets,
    glpi_priority_label,
    glpi_status_label,
    normalize_base_url,
    push_tickets,
)
from app.models import GlpiConfig, ServiceRequest, User, service_request_assignees
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


def _display_user(user: User | None) -> str | None:
    if user is None:
        return None
    full = (user.full_name or "").strip()
    if full:
        return full
    name = (user.username or "").strip()
    return name or None


async def _ticket_people_map(
    db: AsyncSession,
    rows: list[ServiceRequest],
) -> dict[int, dict[str, str | None]]:
    """Инициатор и первый ответственный для выгрузки в GLPI (в т.ч. закрытых)."""
    out: dict[int, dict[str, str | None]] = {
        row.id: {"requester": (row.requester_name or "").strip() or None, "assignee": None}
        for row in rows
    }
    creator_ids = {row.created_by_id for row in rows if row.created_by_id}
    creators: dict[int, User] = {}
    if creator_ids:
        result = await db.execute(select(User).where(User.id.in_(creator_ids)))
        creators = {user.id: user for user in result.scalars().all()}
    for row in rows:
        if out[row.id]["requester"]:
            continue
        out[row.id]["requester"] = _display_user(creators.get(row.created_by_id))

    request_ids = [row.id for row in rows]
    if not request_ids:
        return out
    assign_q = await db.execute(
        select(service_request_assignees.c.request_id, User)
        .join(User, User.id == service_request_assignees.c.user_id)
        .where(service_request_assignees.c.request_id.in_(request_ids))
        .order_by(service_request_assignees.c.request_id, User.id)
    )
    seen: set[int] = set()
    for request_id, user in assign_q.all():
        rid = int(request_id)
        if rid in seen:
            continue
        seen.add(rid)
        if rid in out:
            out[rid]["assignee"] = _display_user(user)
    return out


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
    mode: str = "recent",
    on_progress: Callable[[int, int, GlpiPushResult], None] | None = None,
) -> GlpiSyncResult:
    """Выгрузка заявок в GLPI.

    Связь — только ``ServiceRequest.glpi_id`` (id заявки в GLPI).
    CORAX id и GLPI id не совпадают и не должны подставляться друг за друга.
    Без ``glpi_id`` → CREATE; с ``glpi_id`` → UPDATE этой заявки в GLPI.
    """
    bounded = max(1, min(int(limit), 2000))
    export_mode = (mode or "recent").strip().lower()
    if request_ids:
        export_mode = "selected"

    stmt = select(ServiceRequest)
    if export_mode == "selected":
        ids = list(dict.fromkeys(int(item) for item in (request_ids or [])))[:bounded]
        if not ids:
            return GlpiSyncResult(message="Укажите id заявок CORAX для выборочной выгрузки")
        stmt = stmt.where(ServiceRequest.id.in_(ids))
    elif export_mode == "test_one":
        # Одна свежая заявка без связи — безопасная проверка CREATE.
        stmt = (
            stmt.where(ServiceRequest.glpi_id.is_(None))
            .order_by(ServiceRequest.updated_at.desc(), ServiceRequest.id.desc())
            .limit(1)
        )
    elif export_mode == "new_only":
        stmt = (
            stmt.where(ServiceRequest.glpi_id.is_(None))
            .order_by(ServiceRequest.updated_at.desc(), ServiceRequest.id.desc())
            .limit(bounded)
        )
    elif export_mode == "linked_only":
        stmt = (
            stmt.where(ServiceRequest.glpi_id.isnot(None))
            .order_by(ServiceRequest.updated_at.desc(), ServiceRequest.id.desc())
            .limit(bounded)
        )
    else:
        stmt = stmt.order_by(ServiceRequest.updated_at.desc(), ServiceRequest.id.desc()).limit(bounded)

    rows = list((await db.execute(stmt)).scalars().all())
    if not rows and export_mode == "test_one":
        # Если все уже связаны — берём одну любую свежую (будет UPDATE / match по названию).
        fallback = await db.execute(
            select(ServiceRequest)
            .order_by(ServiceRequest.updated_at.desc(), ServiceRequest.id.desc())
            .limit(1)
        )
        rows = list(fallback.scalars().all())
    if not rows:
        empty_hint = {
            "new_only": "Нет заявок без связи с GLPI (все уже с glpi_id)",
            "linked_only": "Нет заявок, уже связанных с GLPI",
            "selected": "По указанным id заявки не найдены",
            "test_one": "В CORAX нет заявок для тестовой выгрузки",
        }.get(export_mode, "В CORAX нет заявок для выгрузки в GLPI")
        return GlpiSyncResult(message=empty_hint)

    people = await _ticket_people_map(db, rows)
    outbound = [
        GlpiOutbound(
            corax_id=row.id,
            glpi_id=row.glpi_id,
            title=row.title or f"CORAX #{row.id}",
            content=(row.description or "")[:_CONTENT_SAFE],
            status=row.status or "open",
            priority=row.priority or "normal",
            requester=people[row.id]["requester"],
            assignee=people[row.id]["assignee"],
            category=(row.category or "").strip() or None,
        )
        for row in rows
    ]
    results = await asyncio.to_thread(
        push_tickets,
        creds,
        outbound,
        on_progress=on_progress,
    )
    by_id = {row.id: row for row in rows}
    created = updated = failed = skipped = 0
    errors: list[str] = []
    now = datetime.now(timezone.utc)
    base = normalize_base_url(creds.base_url)
    for result in results:
        row = by_id.get(result.corax_id)
        if result.action == "failed" or result.glpi_id is None or row is None:
            failed += 1
            if result.error and len(errors) < _ERROR_LIMIT:
                linked = f", GLPI #{row.glpi_id}" if row is not None and row.glpi_id else ""
                action = "UPDATE" if row is not None and row.glpi_id else "CREATE"
                extra = f" ({result.detail})" if result.detail else ""
                errors.append(f"#{result.corax_id}{linked} [{action}]: {result.error}{extra}")
            continue
        previous = row.glpi_id
        row.glpi_id = result.glpi_id
        row.glpi_status = glpi_status_label(row.status)
        row.glpi_priority = glpi_priority_label(row.priority)
        row.glpi_updated_at = now
        row.external_url = f"{base}/front/ticket.form.php?id={result.glpi_id}"[:512]
        if not (row.external_source or "").strip():
            row.external_source = "glpi"
            row.external_id = str(result.glpi_id)
        elif result.action == "created" and previous and previous != result.glpi_id:
            row.external_id = str(result.glpi_id)
            row.external_source = "glpi"
        if result.action == "created":
            created += 1
            if result.detail and len(errors) < _ERROR_LIMIT and "старая связь" in (result.detail or ""):
                # Informative, not a hard failure — keep in errors list as notice? Better skip.
                pass
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
    mode_label = {
        "new_only": "только новые",
        "linked_only": "только связанные",
        "selected": "выбранные",
        "recent": "последние",
        "test_one": "тестовая одна",
    }.get(export_mode, export_mode)
    message = (
        f"Выгрузка в GLPI ({mode_label}): создано {created}, обновлено {updated}, "
        f"ошибок {failed}"
    )
    return GlpiSyncResult(
        created=created,
        updated=updated,
        skipped=skipped,
        failed=failed,
        message=message,
        errors=errors,
    )


async def apply_glpi_ticket_links(
    db: AsyncSession,
    items: list[tuple[int, int | None]],
    *,
    base_url: str | None = None,
) -> GlpiSyncResult:
    """Переписать glpi_id у заявок CORAX (снять связь или подставить другой id).

    null → следующая выгрузка сделает CREATE. Число → UPDATE этой заявки в GLPI.
    """
    if not items:
        return GlpiSyncResult(message="Нечего менять")
    request_ids = list(dict.fromkeys(rid for rid, _ in items))
    rows = list((await db.execute(select(ServiceRequest).where(ServiceRequest.id.in_(request_ids)))).scalars().all())
    by_id = {row.id: row for row in rows}
    base = normalize_base_url(base_url or "") if base_url else ""
    updated = cleared = skipped = failed = 0
    errors: list[str] = []
    touched: list[ServiceRequest] = []
    for request_id, glpi_id in items:
        row = by_id.get(request_id)
        if row is None:
            failed += 1
            if len(errors) < _ERROR_LIMIT:
                errors.append(f"#{request_id}: заявка CORAX не найдена")
            continue
        if glpi_id is not None and glpi_id <= 0:
            failed += 1
            if len(errors) < _ERROR_LIMIT:
                errors.append(f"#{request_id}: glpi_id должен быть ≥ 1 или пустым")
            continue
        previous = row.glpi_id
        if previous == glpi_id:
            skipped += 1
            continue
        row.glpi_id = glpi_id
        if glpi_id is None:
            cleared += 1
            if (row.external_source or "").strip().casefold() == "glpi":
                row.external_id = None
                row.external_url = None
                row.external_source = None
            row.glpi_status = None
            row.glpi_priority = None
            row.glpi_updated_at = None
        else:
            updated += 1
            if base:
                row.external_url = f"{base}/front/ticket.form.php?id={glpi_id}"[:512]
            if not (row.external_source or "").strip():
                row.external_source = "glpi"
            row.external_id = str(glpi_id)
        touched.append(row)
    if touched:
        await db.flush()
        await index_service_requests(db, touched)
    await db.commit()
    message = (
        f"Связи GLPI: переписано {updated}, снято {cleared}, "
        f"без изменений {skipped}, ошибок {failed}"
    )
    # created = снято (cleared), updated = переписано на новый id
    return GlpiSyncResult(
        created=cleared,
        updated=updated,
        skipped=skipped,
        failed=failed,
        message=message,
        errors=errors,
    )
