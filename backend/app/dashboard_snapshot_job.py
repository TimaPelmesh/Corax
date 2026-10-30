"""One-shot dashboard rebuild. Spawned by DashboardSnapshotWorker, never by Uvicorn.

    python -m app.dashboard_snapshot_job
"""

from __future__ import annotations

import asyncio
import os
import sys

from app.observability import get_logger

log = get_logger("corax.dashboard_snapshot_job")

# Office and disk charts. Counts and tickets refresh without rereading agent reports.
_HEAVY_FIELDS = (
    "browsers",
    "office_suites",
    "physical_disks_total",
    "physical_disks_by_media",
    "physical_disks_by_size",
    "physical_disks_by_variant",
)


async def _run() -> None:
    from app.dashboard_snapshot import read_dashboard_snapshot, save_dashboard_snapshot
    from app.database import AsyncSessionLocal
    from app.routers.dashboard import (
        _compute_dashboard_inventory,
        _dashboard_stamp,
        _stamp_key,
    )
    from app.schemas import DashboardSummary

    async with AsyncSessionLocal() as db:
        stamp = await _dashboard_stamp(db)
        existing = await read_dashboard_snapshot(db)
    key = _stamp_key(stamp)
    if existing is not None and existing[1] == key:
        log.info("dashboard snapshot unchanged")
        return
    want_heavy = os.environ.get("CORAX_SNAPSHOT_HEAVY", "1") != "0" or existing is None
    previous = None
    if not want_heavy and existing is not None:
        try:
            previous = DashboardSummary.model_validate_json(existing[0])
        except Exception:
            want_heavy = True
            previous = None
    inventory = await _compute_dashboard_inventory(None, stamp[:2], heavy=want_heavy)
    if previous is not None:
        inventory = inventory.model_copy(update={name: getattr(previous, name) for name in _HEAVY_FIELDS})
    async with AsyncSessionLocal() as db:
        await save_dashboard_snapshot(db, inventory.model_dump_json(), key)
    log.info("dashboard snapshot saved", extra={"heavy": want_heavy})


def main() -> int:
    try:
        asyncio.run(_run())
    except Exception:
        log.exception("dashboard snapshot job failed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
