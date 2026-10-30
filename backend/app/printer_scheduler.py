"""Printer SNMP poll on its own thread and asyncpg pool.

A cycle can sit on the network for minutes. It must not share the event loop
or the connection pool that serves the panel.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.database import AsyncSessionLocal, _create_engine
from app.observability import get_logger
from app.printer_poll import run_printer_poll_cycle
from app.printer_poll_config import get_effective_printer_poll_config

log = get_logger("corax.printer_poll")


class PrinterPollScheduler:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread_stop = threading.Event()
        self._wake = threading.Event()
        self._session_factory: async_sessionmaker[AsyncSession] | None = None
        self.running = False
        self.next_run_at: datetime | None = None

    async def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread_stop.clear()
        self._thread = threading.Thread(target=self._thread_main, name="corax-printer-poll", daemon=True)
        self._thread.start()
        for _ in range(80):
            if self._loop is not None and self._loop.is_running() and self._session_factory is not None:
                return
            await asyncio.sleep(0.05)
        log.warning("printer poll worker did not become ready")

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

    def wake(self) -> None:
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
            interval_min = 15
            enabled = True
            factory = self._session_factory
            if factory is None:
                break
            self._wake.clear()
            try:
                async with factory() as db:
                    cfg = await get_effective_printer_poll_config(db)
                    interval_min = cfg.poll_interval_minutes
                    enabled = cfg.poll_enabled
            except Exception as exc:
                log.warning("config read error: %s", exc)

            if enabled and not self._thread_stop.is_set():
                try:
                    self.running = True
                    async with factory() as db:
                        await run_printer_poll_cycle(db, triggered_by="scheduler")
                except Exception as exc:
                    log.warning("scheduler error: %s", exc)
                finally:
                    self.running = False

            if self._thread_stop.is_set():
                break

            wait_sec = max(60, interval_min * 60)
            self.next_run_at = datetime.now(timezone.utc) + timedelta(seconds=wait_sec)
            await self._wait(wait_sec)

    async def _wait(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not self._thread_stop.is_set():
            if self._wake.is_set():
                self._wake.clear()
                return
            await asyncio.sleep(0.4)

    async def status(self) -> dict:
        last_run_at = None
        last_summary = None
        poll_enabled = True
        interval = 15
        try:
            async with AsyncSessionLocal() as db:
                cfg = await get_effective_printer_poll_config(db)
                poll_enabled = cfg.poll_enabled
                interval = cfg.poll_interval_minutes
                last_run_at = cfg.last_run_at.isoformat() if cfg.last_run_at else None
                if cfg.last_run_summary_json:
                    last_summary = json.loads(cfg.last_run_summary_json)
        except Exception:
            pass
        thread = self._thread
        return {
            "scheduler_active": thread is not None and thread.is_alive(),
            "running_now": self.running,
            "poll_enabled": poll_enabled,
            "poll_interval_minutes": interval,
            "next_run_at": self.next_run_at.isoformat() if self.next_run_at else None,
            "last_run_at": last_run_at,
            "last_run_summary": last_summary,
        }


printer_poll_scheduler = PrinterPollScheduler()
