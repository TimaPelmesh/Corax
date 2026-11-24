"""Mirror Bitrix bot tickets into GLPI and pull a solved status back."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bitrix_bot_notify import deliver_close_notice, plan_close_notice
from app.database import AsyncSessionLocal
from app.glpi_client import (
    GlpiOutbound,
    glpi_priority_label,
    glpi_status_label,
    push_tickets,
    read_ticket_corax_status,
)
from app.glpi_sync import creds_from_row
from app.models import GlpiConfig, ServiceRequest
from app.search_index import index_service_request
from app.service_request_tickets import ensure_ticket_no, is_service_request_closed, stamp_closed_at_if_needed

log = logging.getLogger("corax.glpi.bot")

_POLL_SECONDS = 90
_POLL_LIMIT = 40


def _mirror_on(row: GlpiConfig | None) -> bool:
    if row is None or not row.enabled or not (row.base_url or "").strip():
        return False
    return bool(getattr(row, "mirror_bot_tickets", False))


async def mirror_bitrix_ticket(db: AsyncSession, request_id: int) -> None:
    """Create the GLPI ticket for a Bitrix request, under the requester's name."""
    cfg = (await db.execute(select(GlpiConfig).order_by(GlpiConfig.id).limit(1))).scalar_one_or_none()
    if not _mirror_on(cfg):
        return
    row = await db.get(ServiceRequest, request_id)
    if row is None or row.glpi_id or (row.external_source or "") != "bitrix24":
        return
    requester = (row.requester_name or "").strip() or None
    item = GlpiOutbound(
        corax_id=row.id,
        glpi_id=None,
        title=(row.title or f"CORAX #{row.id}")[:255],
        content=(row.description or "")[:20_000],
        status=row.status or "open",
        priority=row.priority or "normal",
        requester=requester,
        category=(row.category or "").strip() or None,
        force_create=True,
        opened_at=row.opened_at or row.created_at,
    )
    try:
        results = await asyncio.to_thread(push_tickets, creds_from_row(cfg), [item])
    except Exception:
        log.exception("glpi mirror failed for request %s", request_id)
        return
    if not results or results[0].glpi_id is None:
        detail = results[0].error if results else "empty"
        log.warning("glpi mirror did not create a ticket for #%s: %s", request_id, detail)
        return
    result = results[0]
    row.glpi_id = result.glpi_id
    row.glpi_status = glpi_status_label(row.status)
    row.glpi_priority = glpi_priority_label(row.priority)
    row.glpi_updated_at = datetime.now(timezone.utc)
    base = (cfg.base_url or "").rstrip("/")
    row.external_url = f"{base}/front/ticket.form.php?id={result.glpi_id}"[:512]
    await db.commit()
    log.info("glpi mirror created #%s as GLPI #%s requester=%s", row.id, result.glpi_id, requester or "—")


def _read_status(cfg: GlpiConfig, glpi_id: int) -> str | None:
    return read_ticket_corax_status(creds_from_row(cfg), glpi_id)


async def pull_solved_statuses() -> int:
    """If GLPI closed a mirrored ticket, mark the Corax request done."""
    async with AsyncSessionLocal() as db:
        cfg = (await db.execute(select(GlpiConfig).order_by(GlpiConfig.id).limit(1))).scalar_one_or_none()
        if not _mirror_on(cfg):
            return 0
        rows = list(
            (
                await db.execute(
                    select(ServiceRequest)
                    .where(
                        ServiceRequest.external_source == "bitrix24",
                        ServiceRequest.glpi_id.isnot(None),
                        ServiceRequest.status.notin_(("done", "cancelled")),
                    )
                    .order_by(ServiceRequest.id.desc())
                    .limit(_POLL_LIMIT)
                )
            ).scalars().all()
        )
        if not rows:
            return 0
        notices = []
        changed = 0
        for row in rows:
            try:
                status = await asyncio.to_thread(_read_status, cfg, int(row.glpi_id))
            except Exception:
                log.exception("glpi status read failed for #%s", row.id)
                continue
            if status is None:
                continue
            if status == "done":
                was_closed = is_service_request_closed(row)
                row.status = "done"
                row.glpi_status = glpi_status_label("done")
                row.glpi_updated_at = datetime.now(timezone.utc)
                stamp_closed_at_if_needed(row, was_closed=was_closed)
                await ensure_ticket_no(db, row)
                await index_service_request(db, row)
                notice = await plan_close_notice(db, row)
                if notice is not None:
                    notices.append(notice)
                changed += 1
            elif status == "in_progress" and (row.status or "") == "open":
                row.status = "in_progress"
                row.glpi_status = glpi_status_label("in_progress")
                row.glpi_updated_at = datetime.now(timezone.utc)
                await index_service_request(db, row)
                changed += 1
        if changed:
            await db.commit()
        else:
            await db.rollback()
    for notice in notices:
        try:
            await deliver_close_notice(notice)
        except Exception:
            log.exception("bitrix close notice failed for #%s", notice.get("request_id"))
    return changed


class GlpiBotMirrorScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if self._task is not None:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stop.set()
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await pull_solved_statuses()
            except Exception:
                log.exception("glpi bot status poll failed")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=_POLL_SECONDS)
            except TimeoutError:
                continue


glpi_bot_mirror = GlpiBotMirrorScheduler()
