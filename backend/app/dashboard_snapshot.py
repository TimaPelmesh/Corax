"""Dashboard snapshot supervisor.

The heavy inventory pass runs in a child process (`python -m app.dashboard_snapshot_job`).
Keeping it inside Uvicorn froze the panel: the software/raw_payload fold holds the GIL,
so the API event loop stopped running while the fold was on.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.observability import get_logger

log = get_logger("corax.dashboard_snapshot")

_FIRST_DELAY_SEC = 12
_MIN_GAP_SEC = 30
_IDLE_SEC = 120
_CHILD_TIMEOUT_SEC = 600


def _backend_dir() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _kill_proc(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.kill()
    except OSError:
        return
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        pass


class DashboardSnapshotWorker:
    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._thread_stop = threading.Event()
        self._wake = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._proc_lock = threading.Lock()

    async def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread_stop.clear()
        self._wake.set()
        self._thread = threading.Thread(
            target=self._thread_main, name="corax-dashboard-snapshot", daemon=True
        )
        self._thread.start()

    async def stop(self) -> None:
        self._thread_stop.set()
        self._wake.set()
        with self._proc_lock:
            proc = self._proc
        if proc is not None:
            _kill_proc(proc)
        if self._thread:
            self._thread.join(timeout=8)
        self._thread = None

    def request_refresh(self) -> None:
        """Non-blocking. Safe from the API thread after an inventory commit."""
        self._wake.set()

    def _thread_main(self) -> None:
        if self._thread_stop.wait(_FIRST_DELAY_SEC):
            return
        while not self._thread_stop.is_set():
            self._wake.clear()
            self._run_child()
            if self._thread_stop.is_set():
                break
            kicked = self._pause(_MIN_GAP_SEC)
            if self._thread_stop.is_set():
                break
            if not kicked:
                self._wake.wait(_IDLE_SEC)

    def _pause(self, seconds: float) -> bool:
        """Sleep the full gap. A kick during the sleep is remembered, not acted on early."""
        kicked = False
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not self._thread_stop.is_set():
            if self._wake.is_set():
                kicked = True
            self._thread_stop.wait(0.4)
        return kicked

    def _run_child(self) -> None:
        with self._proc_lock:
            current = self._proc
        if current is not None and current.poll() is None:
            return
        backend = _backend_dir()
        env = os.environ.copy()
        env["PYTHONPATH"] = backend + os.pathsep + env.get("PYTHONPATH", "")
        kwargs: dict = {}
        if os.name != "nt":
            kwargs["start_new_session"] = True
        try:
            proc = subprocess.Popen(
                [sys.executable, "-m", "app.dashboard_snapshot_job"],
                cwd=backend,
                env=env,
                **kwargs,
            )
        except Exception as exc:
            log.warning("dashboard snapshot child failed to start: %s", exc)
            return
        with self._proc_lock:
            self._proc = proc
        log.info("dashboard snapshot child started", extra={"pid": proc.pid})
        try:
            code = proc.wait(timeout=_CHILD_TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            log.warning("dashboard snapshot child timed out", extra={"pid": proc.pid})
            _kill_proc(proc)
            return
        if code != 0:
            log.warning("dashboard snapshot child exited", extra={"pid": proc.pid, "code": code})
        else:
            log.info("dashboard snapshot child finished", extra={"pid": proc.pid})


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


async def save_dashboard_snapshot(db: AsyncSession, payload: str, stamp: str) -> None:
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
        {"payload": payload, "stamp": stamp},
    )
    await db.commit()


dashboard_snapshot_worker = DashboardSnapshotWorker()
