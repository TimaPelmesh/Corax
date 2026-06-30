"""Порядковый номер заявки (ticket_no) — выдаётся при закрытии, 1..N по времени закрытия."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ServiceRequest

_CLOSED_STATUSES = frozenset({"done", "cancelled"})


def is_service_request_closed(row: ServiceRequest) -> bool:
    return row.status in _CLOSED_STATUSES or row.closed_at is not None


async def next_ticket_no(db: AsyncSession) -> int:
    current = await db.scalar(select(func.max(ServiceRequest.ticket_no)))
    return int(current or 0) + 1


async def ensure_ticket_no(db: AsyncSession, row: ServiceRequest) -> None:
    """Присвоить ticket_no закрытой заявке, если ещё не был выдан."""
    if row.ticket_no is not None:
        return
    if not is_service_request_closed(row):
        return
    row.ticket_no = await next_ticket_no(db)


def stamp_closed_at_if_needed(row: ServiceRequest, was_closed: bool) -> None:
    """При первом закрытии проставить closed_at, если пользователь не указал вручную."""
    if was_closed or not is_service_request_closed(row) or row.closed_at is not None:
        return
    row.closed_at = datetime.now(timezone.utc)
