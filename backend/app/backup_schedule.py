"""Scheduled dump check. The archive is inspected and discarded, not restored."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models import BackupSchedule
from app.product_depth import backup_due, dump_can_open

log = logging.getLogger("corax.backup")


async def ensure_schedule(db: AsyncSession) -> BackupSchedule:
    row = (await db.execute(select(BackupSchedule).order_by(BackupSchedule.id).limit(1))).scalar_one_or_none()
    if row is not None:
        return row
    row = BackupSchedule(enabled=False, interval_hours=24, last_message="")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def schedule_view(row: BackupSchedule, now: datetime | None = None) -> dict:
    moment = now or datetime.now(timezone.utc)
    last = row.last_run_at
    return {
        "enabled": bool(row.enabled),
        "interval_hours": int(row.interval_hours or 24),
        "last_run_at": last.isoformat() if last is not None else None,
        "last_ok": row.last_ok,
        "last_message": row.last_message or "",
        "due": backup_due(bool(row.enabled), int(row.interval_hours or 24), last, moment),
    }


async def run_backup_check() -> dict:
    from app.pg_backup import create_database_dump

    try:
        data, _name = await asyncio.to_thread(create_database_dump)
        ok, reason = dump_can_open(data)
        message = "заголовок архива открывается" if ok else reason
    except Exception as exc:
        ok = False
        message = str(exc)[:255] or "дамп не снят"
    async with AsyncSessionLocal() as db:
        row = await ensure_schedule(db)
        row.last_run_at = datetime.now(timezone.utc)
        row.last_ok = ok
        row.last_message = message[:255]
        await db.commit()
        await db.refresh(row)
        return schedule_view(row)


class BackupScheduler:
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
                await self._tick()
            except Exception:
                log.exception("backup schedule tick failed")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=900)
            except TimeoutError:
                continue

    async def _tick(self) -> None:
        async with AsyncSessionLocal() as db:
            row = await ensure_schedule(db)
            due = backup_due(bool(row.enabled), int(row.interval_hours or 24), row.last_run_at, datetime.now(timezone.utc))
        if due:
            await run_backup_check()


backup_scheduler = BackupScheduler()
