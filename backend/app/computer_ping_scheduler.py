"""
PC fleet ping scheduler.

Strategy (network-safe + timely):
1) Soon after boot — one careful full batched sweep (indicators fill quickly).
2) Steady state — rolling drip: every tick ping a small stale batch so the
   whole park refreshes across the interval without a traffic storm.
3) Never two heavy cycles at once; concurrency / batch pauses / jitter capped.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from app.computer_ping import _clamp_settings, run_computer_ping_cycle, run_computer_ping_drip
from app.config import settings
from app.database import AsyncSessionLocal


class ComputerPingScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._kick_task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.running = False
        self.next_run_at: datetime | None = None
        self.last_summary: dict | None = None
        self.mode: str = "idle"
        self._last_kick_at: datetime | None = None

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="computer-ping-scheduler")

    async def stop(self) -> None:
        self._stop.set()
        for task in (self._kick_task, self._task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._kick_task = None
        self._task = None

    def request_full(self, *, reason: str = "kick") -> dict:
        """Non-blocking: start a batched full sweep if nothing heavy is running."""
        if self.running:
            return {"started": False, "reason": "busy", "mode": self.mode}
        if self._kick_task and not self._kick_task.done():
            return {"started": False, "reason": "kick_pending", "mode": self.mode}
        now = datetime.now(timezone.utc)
        if self._last_kick_at and (now - self._last_kick_at).total_seconds() < 45:
            return {"started": False, "reason": "cooldown", "mode": self.mode}
        self._last_kick_at = now
        self._kick_task = asyncio.create_task(self._run_full(reason=reason), name=f"computer-ping-{reason}")
        return {"started": True, "reason": reason, "mode": f"full:{reason}"}

    async def _sleep(self, seconds: float) -> bool:
        if seconds <= 0:
            return self._stop.is_set()
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
            return True
        except asyncio.TimeoutError:
            return False

    async def _loop(self) -> None:
        if await self._sleep(2):
            return

        if bool(getattr(settings, "computer_ping_enabled", True)):
            await self._run_full(reason="startup")

        while not self._stop.is_set():
            enabled = bool(getattr(settings, "computer_ping_enabled", True))
            cfg = _clamp_settings()
            interval_min = int(cfg["interval_minutes"])
            batch_size = int(cfg["batch_size"])

            if not enabled:
                self.mode = "disabled"
                self.next_run_at = datetime.now(timezone.utc) + timedelta(minutes=1)
                if await self._sleep(60):
                    return
                continue

            # Spread small drips across the interval (~20–40s between batches).
            tick_sec = max(20.0, min(40.0, (interval_min * 60) / 25.0))
            drip_limit = max(2, min(batch_size, 12))
            self.mode = "drip"
            self.next_run_at = datetime.now(timezone.utc) + timedelta(seconds=tick_sec)

            try:
                self.running = True
                async with AsyncSessionLocal() as db:
                    summary = await run_computer_ping_drip(db, limit=drip_limit)
                    self.last_summary = summary
                    if summary.get("polled", 0):
                        print(
                            f"[ComputerPing:drip] {summary.get('online', 0)}/"
                            f"{summary.get('polled', 0)} online "
                            f"(c={summary.get('concurrency')})",
                            flush=True,
                        )
            except Exception as e:
                print(f"[ComputerPing:drip] error: {e}", flush=True)
            finally:
                self.running = False

            if await self._sleep(tick_sec):
                return

    async def _run_full(self, *, reason: str) -> None:
        try:
            self.running = True
            self.mode = f"full:{reason}"
            async with AsyncSessionLocal() as db:
                summary = await run_computer_ping_cycle(db, reason=reason)
                self.last_summary = summary
                if summary.get("skipped"):
                    print(f"[ComputerPing:full] skipped ({summary.get('reason')})", flush=True)
                else:
                    print(
                        f"[ComputerPing:full/{reason}] "
                        f"{summary.get('online', 0)}/{summary.get('polled', 0)} online "
                        f"batches={summary.get('batches')} "
                        f"c={summary.get('concurrency')} "
                        f"{summary.get('elapsed_ms')}ms",
                        flush=True,
                    )
        except Exception as e:
            print(f"[ComputerPing:full] error: {e}", flush=True)
        finally:
            self.running = False
            self.mode = "idle"


computer_ping_scheduler = ComputerPingScheduler()
