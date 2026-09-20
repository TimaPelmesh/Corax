"""
PC fleet ping — dedicated worker thread (own asyncio loop + DB engine).

ICMP subprocess and ORM sweeps must not share the FastAPI event loop.
"""

from __future__ import annotations

import asyncio
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.computer_ping import _clamp_settings, run_computer_ping_cycle, run_computer_ping_drip
from app.config import settings
from app.database import _create_engine
from app.observability import get_logger

log = get_logger("corax.computer_ping")


class ComputerPingScheduler:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread_stop = threading.Event()
        self._session_factory: async_sessionmaker[AsyncSession] | None = None
        self._kick_pending = False
        self._state_lock = threading.Lock()
        self.running = False
        self.next_run_at: datetime | None = None
        self.last_summary: dict | None = None
        self.mode: str = "idle"
        self._last_kick_at: datetime | None = None

    async def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread_stop.clear()
        self._thread = threading.Thread(target=self._thread_main, name="corax-ping-worker", daemon=True)
        self._thread.start()
        for _ in range(80):
            if self._loop is not None and self._loop.is_running() and self._session_factory is not None:
                return
            await asyncio.sleep(0.05)
        log.warning("computer ping worker did not become ready")

    async def stop(self) -> None:
        self._thread_stop.set()
        loop = self._loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(lambda: None)
        if self._thread:
            self._thread.join(timeout=8)
        self._thread = None
        self._loop = None
        self._session_factory = None

    def request_full(self, *, reason: str = "kick") -> dict:
        """Non-blocking: schedule a batched full sweep on the ping worker."""
        with self._state_lock:
            if self.running:
                return {"started": False, "reason": "busy", "mode": self.mode}
            if self._kick_pending:
                return {"started": False, "reason": "kick_pending", "mode": self.mode}
            now = datetime.now(timezone.utc)
            if self._last_kick_at and (now - self._last_kick_at).total_seconds() < 90:
                return {"started": False, "reason": "cooldown", "mode": self.mode}
            self._last_kick_at = now
            self._kick_pending = True
        loop = self._loop
        if loop is None or not loop.is_running():
            with self._state_lock:
                self._kick_pending = False
            return {"started": False, "reason": "not_started", "mode": self.mode}
        asyncio.run_coroutine_threadsafe(self._run_full(reason=reason), loop)
        return {"started": True, "reason": reason, "mode": f"full:{reason}"}

    def _thread_main(self) -> None:
        asyncio.run(self._async_main())

    async def _async_main(self) -> None:
        self._loop = asyncio.get_running_loop()
        engine = _create_engine(settings.database_url)
        self._session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        try:
            await self._loop_body()
        finally:
            self._session_factory = None
            await engine.dispose()
            self._loop = None

    async def _sleep(self, seconds: float) -> bool:
        if seconds <= 0:
            return self._thread_stop.is_set()
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if self._thread_stop.is_set():
                return True
            await asyncio.sleep(min(0.4, max(0.05, end - time.monotonic())))
        return self._thread_stop.is_set()

    def _db(self):
        factory = self._session_factory
        if factory is None:
            raise RuntimeError("ping worker session factory is not ready")
        return factory()

    async def _loop_body(self) -> None:
        if await self._sleep(2):
            return

        if bool(getattr(settings, "computer_ping_enabled", True)):
            await self._run_full(reason="startup")

        while not self._thread_stop.is_set():
            enabled = bool(getattr(settings, "computer_ping_enabled", True))
            cfg = _clamp_settings()
            interval_min = int(cfg["interval_minutes"])
            batch_size = int(cfg["batch_size"])

            if not enabled:
                with self._state_lock:
                    self.mode = "disabled"
                    self.next_run_at = datetime.now(timezone.utc) + timedelta(minutes=1)
                if await self._sleep(60):
                    return
                continue

            fleet_n = 0
            try:
                from sqlalchemy import func, select

                from app.models import Computer

                async with self._db() as db:
                    fleet_n = int(await db.scalar(select(func.count()).select_from(Computer)) or 0)
            except Exception:
                fleet_n = 0

            if fleet_n >= 800:
                tick_sec = max(6.0, min(12.0, (interval_min * 60) / 80.0))
                drip_limit = max(12, min(max(batch_size, 24), 40))
            elif fleet_n >= 200:
                tick_sec = max(7.0, min(14.0, (interval_min * 60) / 60.0))
                drip_limit = max(8, min(max(batch_size, 16), 28))
            else:
                tick_sec = max(8.0, min(18.0, (interval_min * 60) / 50.0))
                drip_limit = max(4, min(batch_size, 16))
            with self._state_lock:
                self.mode = "drip"
                self.next_run_at = datetime.now(timezone.utc) + timedelta(seconds=tick_sec)

            try:
                with self._state_lock:
                    self.running = True
                async with self._db() as db:
                    summary = await run_computer_ping_drip(db, limit=drip_limit)
                    with self._state_lock:
                        self.last_summary = summary
                    if summary.get("polled", 0):
                        log.info(
                            "drip",
                            extra={
                                "online": summary.get("online", 0),
                                "polled": summary.get("polled", 0),
                                "concurrency": summary.get("concurrency"),
                            },
                        )
            except Exception as e:
                log.warning("drip error: %s", e)
            finally:
                with self._state_lock:
                    self.running = False

            if await self._sleep(tick_sec):
                return

    async def _run_full(self, *, reason: str) -> None:
        try:
            with self._state_lock:
                self.running = True
                self.mode = f"full:{reason}"
            async with self._db() as db:
                summary = await run_computer_ping_cycle(db, reason=reason)
                with self._state_lock:
                    self.last_summary = summary
                if summary.get("skipped"):
                    log.info("full skipped", extra={"reason": summary.get("reason")})
                else:
                    log.info(
                        "full",
                        extra={
                            "trigger": reason,
                            "online": summary.get("online", 0),
                            "polled": summary.get("polled", 0),
                            "batches": summary.get("batches"),
                            "concurrency": summary.get("concurrency"),
                            "elapsed_ms": summary.get("elapsed_ms"),
                        },
                    )
        except Exception as e:
            log.warning("full error: %s", e)
        finally:
            with self._state_lock:
                self.running = False
                self.mode = "idle"
                self._kick_pending = False


computer_ping_scheduler = ComputerPingScheduler()
