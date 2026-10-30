"""Precomputed dashboard inventory, off the API event loop.

GET /dashboard/summary reads one row. This thread owns a private asyncpg pool
and rebuilds that row after agent reports and on a quiet interval.
"""

from __future__ import annotations

import asyncio
import threading
import time

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.database import _create_engine
from app.observability import get_logger

log = get_logger("corax.dashboard_snapshot")

_MIN_GAP_SEC = 25
_IDLE_SEC = 90


class DashboardSnapshotWorker:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread_stop = threading.Event()
        self._wake = threading.Event()
        self._session_factory: async_sessionmaker[AsyncSession] | None = None

    async def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread_stop.clear()
        self._wake.set()
        self._thread = threading.Thread(
            target=self._thread_main, name="corax-dashboard-snapshot", daemon=True
        )
        self._thread.start()
        for _ in range(80):
            if self._loop is not None and self._loop.is_running() and self._session_factory is not None:
                return
            await asyncio.sleep(0.05)
        log.warning("dashboard snapshot worker did not become ready")

    async def stop(self) -> None:
        self._thread_stop.set()
        self._wake.set()
        loop = self._loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(lambda: None)
        if self._thread:
            self._thread.join(timeout=8)
        self._thread = None
        self._loop = None
        self._session_factory = None

    def request_refresh(self) -> None:
        """Non-blocking. Safe from the API thread after an inventory commit."""
        self._wake.set()

    def _thread_main(self) -> None:
        asyncio.run(self._async_main())

    async def _async_main(self) -> None:
        engine = _create_engine(settings.database_url)
        self._session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        self._loop = asyncio.get_running_loop()
        try:
            await self._loop_body()
        finally:
            self._session_factory = None
            self._loop = None
            await engine.dispose()

    async def _loop_body(self) -> None:
        while not self._thread_stop.is_set():
            self._wake.clear()
            try:
                await self._compute_and_save()
            except Exception as exc:
                log.warning("dashboard snapshot failed: %s", exc)
            if self._thread_stop.is_set():
                break
            kicked = await self._rest(_MIN_GAP_SEC)
            if kicked or self._thread_stop.is_set():
                continue
            await self._rest(_IDLE_SEC)

    async def _rest(self, seconds: float) -> bool:
        """Sleep up to `seconds`. True if a refresh was requested during the wait."""
        kicked = False
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not self._thread_stop.is_set():
            if self._wake.is_set():
                kicked = True
                self._wake.clear()
            await asyncio.sleep(0.4)
        return kicked

    async def _compute_and_save(self) -> None:
        from app.routers.dashboard import (
            _compute_dashboard_inventory,
            _dash_session_factory,
            _dashboard_stamp,
            _stamp_key,
        )

        factory = self._session_factory
        if factory is None:
            return
        async with factory() as db:
            stamp = await _dashboard_stamp(db)
            existing = await read_dashboard_snapshot(db)
        key = _stamp_key(stamp)
        if existing is not None and existing[1] == key:
            return
        token = _dash_session_factory.set(factory)
        try:
            inventory = await _compute_dashboard_inventory(None, stamp[:2])
        finally:
            _dash_session_factory.reset(token)
        payload = inventory.model_dump_json()
        async with factory() as db:
            await db.execute(
                text(
                    """
                    INSERT INTO dashboard_snapshots (id, payload, stamp, updated_at)
                    VALUES (1, :payload, :stamp, CURRENT_TIMESTAMP)
                    ON CONFLICT (id) DO UPDATE
                    SET payload = EXCLUDED.payload,
                        stamp = EXCLUDED.stamp,
                        updated_at = CURRENT_TIMESTAMP
                    """
                ),
                {"payload": payload, "stamp": key},
            )
            await db.commit()
        log.info("dashboard snapshot saved", extra={"stamp": key[:80]})


async def read_dashboard_snapshot(db: AsyncSession) -> tuple[str, str] | None:
    try:
        row = (
            await db.execute(text("SELECT payload, stamp FROM dashboard_snapshots WHERE id = 1"))
        ).first()
    except Exception:
        try:
            await db.rollback()
        except Exception:
            pass
        return None
    if row is None or not row[0]:
        return None
    return str(row[0]), str(row[1] or "")


dashboard_snapshot_worker = DashboardSnapshotWorker()
