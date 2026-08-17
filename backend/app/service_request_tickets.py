"""Порядковый номер заявки (ticket_no) — выдаётся при закрытии, 1..N по времени закрытия."""

from __future__ import annotations

from datetime import datetime, timezone

from collections.abc import Iterable

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ServiceRequest

_CLOSED_STATUSES = frozenset({"done", "cancelled"})
_TICKET_NUMBER_LOCK_ID = 1_128_927_675


def is_service_request_closed(row: ServiceRequest) -> bool:
    return row.status in _CLOSED_STATUSES or row.closed_at is not None


async def next_ticket_no(db: AsyncSession) -> int:
    bind = db.get_bind()
    if bind.dialect.name == "postgresql":
        await db.execute(
            text("SELECT pg_advisory_xact_lock(:lock_id)"),
            {"lock_id": _TICKET_NUMBER_LOCK_ID},
        )
    current = await db.scalar(select(func.max(ServiceRequest.ticket_no)))
    return int(current or 0) + 1


async def ensure_ticket_numbers(db: AsyncSession, rows: Iterable[ServiceRequest]) -> None:
    """Assign sequential numbers to all newly closed rows with one MAX query."""
    pending = [row for row in rows if row.ticket_no is None and is_service_request_closed(row)]
    if not pending:
        return
    number = await next_ticket_no(db)
    for row in pending:
        row.ticket_no = number
        number += 1


async def ensure_ticket_no(db: AsyncSession, row: ServiceRequest) -> None:
    """Присвоить ticket_no закрытой заявке, если ещё не был выдан."""
    await ensure_ticket_numbers(db, (row,))


def stamp_closed_at_if_needed(row: ServiceRequest, was_closed: bool) -> None:
    """При первом закрытии проставить closed_at, если пользователь не указал вручную."""
    if was_closed or not is_service_request_closed(row) or row.closed_at is not None:
        return
    row.closed_at = datetime.now(timezone.utc)
