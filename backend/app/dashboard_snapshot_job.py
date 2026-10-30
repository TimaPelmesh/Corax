"""One-shot dashboard rebuild. Spawned by DashboardSnapshotWorker, never by Uvicorn.

    python -m app.dashboard_snapshot_job
"""

from __future__ import annotations

import asyncio
import sys

from app.observability import get_logger

log = get_logger("corax.dashboard_snapshot_job")


async def _run() -> None:
    from app.dashboard_snapshot import read_dashboard_snapshot, save_dashboard_snapshot
    from app.database import AsyncSessionLocal
    from app.routers.dashboard import (
        _compute_dashboard_inventory,
        _dashboard_stamp,
        _stamp_key,
    )

    async with AsyncSessionLocal() as db:
        stamp = await _dashboard_stamp(db)
        existing = await read_dashboard_snapshot(db)
    key = _stamp_key(stamp)
    if existing is not None and existing[1] == key:
        log.info("dashboard snapshot unchanged")
        return
    inventory = await _compute_dashboard_inventory(None, stamp[:2])
    async with AsyncSessionLocal() as db:
        await save_dashboard_snapshot(db, inventory.model_dump_json(), key)
    log.info("dashboard snapshot saved")


def main() -> int:
    try:
        asyncio.run(_run())
    except Exception:
        log.exception("dashboard snapshot job failed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
