from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

from app.database import AsyncSessionLocal
from app.observability import get_logger
from app.printer_poll import run_printer_poll_cycle
from app.printer_poll_config import get_effective_printer_poll_config

log = get_logger("corax.printer_poll")


class PrinterPollScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._wake = asyncio.Event()
        self.running = False
        self.next_run_at: datetime | None = None

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._wake.clear()
        self._task = asyncio.create_task(self._loop(), name="printer-poll-scheduler")

    async def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def wake(self) -> None:
        self._wake.set()

    async def _loop(self) -> None:
        while not self._stop.is_set():
            interval_min = 15
            enabled = True
            try:
                async with AsyncSessionLocal() as db:
                    cfg = await get_effective_printer_poll_config(db)
                    interval_min = cfg.poll_interval_minutes
                    enabled = cfg.poll_enabled
            except Exception as e:
                log.warning("config read error: %s", e)

            if enabled:
                try:
                    self.running = True
                    async with AsyncSessionLocal() as db:
                        await run_printer_poll_cycle(db, triggered_by="scheduler")
                except Exception as e:
                    log.warning("scheduler error: %s", e)
                finally:
                    self.running = False

            if self._stop.is_set():
                break

            wait_sec = max(60, interval_min * 60)
            self.next_run_at = datetime.now(timezone.utc) + timedelta(seconds=wait_sec)
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=wait_sec)
            except asyncio.TimeoutError:
                pass

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
        return {
            "scheduler_active": self._task is not None and not self._task.done(),
            "running_now": self.running,
            "poll_enabled": poll_enabled,
            "poll_interval_minutes": interval,
            "next_run_at": self.next_run_at.isoformat() if self.next_run_at else None,
            "last_run_at": last_run_at,
            "last_run_summary": last_summary,
        }


printer_poll_scheduler = PrinterPollScheduler()
