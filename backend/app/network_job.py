from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

from app.database import AsyncSessionLocal

JobKind = Literal["idle", "discover", "poll"]
JobPhase = Literal[
    "idle",
    "starting",
    "discover",
    "deep_poll",
    "neighbors",
    "links",
    "done",
    "error",
]


@dataclass
class NetworkJobState:
    running: bool = False
    kind: JobKind = "idle"
    phase: JobPhase = "idle"
    progress: int = 0  # 0..100
    message: str = ""
    started_at: datetime | None = None
    finished_at: datetime | None = None
    last_result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


class NetworkJobRunner:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self.state = NetworkJobState()

    def snapshot(self) -> dict[str, Any]:
        s = self.state

        def _iso(dt: datetime | None) -> str | None:
            if dt is None:
                return None
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.isoformat().replace("+00:00", "Z")

        return {
            "running": s.running,
            "kind": s.kind,
            "phase": s.phase,
            "progress": s.progress,
            "message": s.message,
            "started_at": _iso(s.started_at),
            "finished_at": _iso(s.finished_at),
            "last_result": s.last_result,
            "error": s.error,
        }

    def _set(
        self,
        *,
        phase: JobPhase | None = None,
        progress: int | None = None,
        message: str | None = None,
    ) -> None:
        if phase is not None:
            self.state.phase = phase
        if progress is not None:
            self.state.progress = max(0, min(100, int(progress)))
        if message is not None:
            self.state.message = message

    async def start(self, kind: JobKind) -> dict[str, Any]:
        async with self._lock:
            if self.state.running:
                return self.snapshot()
            self.state = NetworkJobState(
                running=True,
                kind=kind,
                phase="starting",
                progress=2,
                message="Запуск…" if kind == "poll" else "Запуск сканирования…",
                started_at=datetime.now(timezone.utc),
            )
            self._task = asyncio.create_task(self._run(kind), name=f"network-job-{kind}")
            return self.snapshot()

    async def _run(self, kind: JobKind) -> None:
        try:
            async with AsyncSessionLocal() as db:
                if kind == "discover":
                    await self._run_discover(db)
                else:
                    await self._run_poll(db)
            self.state.phase = "done"
            self.state.progress = 100
            if not self.state.message:
                self.state.message = "Готово"
            self.state.error = None
        except Exception as e:
            self.state.phase = "error"
            self.state.error = str(e)[:400]
            self.state.message = f"Ошибка: {self.state.error}"
            self.state.progress = 100
            print(f"[NetworkJob] error: {e}", flush=True)
        finally:
            self.state.running = False
            self.state.finished_at = datetime.now(timezone.utc)

    async def _run_discover(self, db) -> None:
        from app.network_poll import (
            _extra_communities,
            enrich_discovered_for_neighbors,
            seed_devices_from_neighbors,
        )
        from app.network_poll_config import get_effective_network_poll_config
        from app.network_snmp_discover import discover_network_devices

        self._set(phase="discover", progress=8, message="Авто-зона CORAX → полный SNMP-скан…")
        cfg = await get_effective_network_poll_config(db)
        extra = await _extra_communities(db, cfg.snmp_community)
        r = await discover_network_devices(
            db,
            community=cfg.snmp_community,
            communities=extra,
            timeout=min(1.4, max(0.7, cfg.snmp_timeout_seconds)),
            total_budget_seconds=420.0,
            concurrency=max(cfg.poll_concurrency, 24),
            cidr_list=cfg.cidr_list or None,
        )
        self._set(phase="neighbors", progress=75, message="Опрос найденных устройств и соседей LLDP/CDP…")
        enriched = await enrich_discovered_for_neighbors(
            db,
            community=cfg.snmp_community,
            timeout=min(4.0, max(2.0, cfg.snmp_timeout_seconds)),
            limit=48,
        )
        seeded = await seed_devices_from_neighbors(
            db,
            community=cfg.snmp_community,
            timeout=min(1.4, max(0.8, cfg.snmp_timeout_seconds)),
        )
        msg = r.message
        if enriched or seeded:
            msg += f" Соседи: deep-poll {enriched}, добавлено по LLDP/CDP {seeded}."
        self.state.last_result = {
            "kind": "discover",
            "scanned": r.scanned,
            "found": r.found,
            "created": r.created,
            "updated": r.updated,
            "skipped": r.skipped,
            "errors": r.errors,
            "seed_ips": r.seed_ips,
            "scope_reasons": r.scope_reasons,
            "neighbor_enriched": enriched,
            "neighbor_seeded": seeded,
            "duration_ms": r.duration_ms,
            "networks": r.networks,
            "message": msg,
        }
        self._set(progress=95, message=msg)

    async def _run_poll(self, db) -> None:
        from app.network_poll import run_network_poll_cycle

        self._set(phase="discover", progress=8, message="Поиск устройств в сети…")

        # Progress callback via patching phases inside poll — run with hooks
        async def on_phase(phase: str, pct: int, msg: str) -> None:
            mapping: dict[str, JobPhase] = {
                "discover": "discover",
                "deep_poll": "deep_poll",
                "neighbors": "neighbors",
                "links": "links",
            }
            self._set(phase=mapping.get(phase, "deep_poll"), progress=pct, message=msg)

        r = await run_network_poll_cycle(
            db,
            with_discovery=True,
            triggered_by="manual",
            progress_cb=on_phase,
        )
        self.state.last_result = {
            "kind": "poll",
            "polled": r.polled,
            "online": r.online,
            "offline": r.offline,
            "snmp_ok": r.snmp_ok,
            "snmp_error": r.snmp_error,
            "duration_ms": r.duration_ms,
            "discovered": r.discovered,
            "discovery_created": r.discovery_created,
            "discovery_updated": r.discovery_updated,
            "neighbor_seeded": r.neighbor_seeded,
            "links_devices": r.links_devices,
            "links_computers": r.links_computers,
            "networks": r.networks,
            "message": r.message,
        }
        self._set(progress=98, message=r.message)


network_job_runner = NetworkJobRunner()
