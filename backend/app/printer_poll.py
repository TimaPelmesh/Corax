from __future__ import annotations

import asyncio
import json
import platform
import subprocess
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.async_pool import run_async_pool
from app.models import Printer
from app.printer_poll_config import EffectivePrinterPollConfig, get_effective_printer_poll_config, get_printer_poll_config_row
from app.printer_snmp import fetch_printer_snmp
from app.printer_cleanup import snmp_tab_clause
from app.printer_snmp_discover import discover_snmp_printers

_WIN32 = platform.system().lower() == "windows"


def _poll_concurrency(cfg: EffectivePrinterPollConfig) -> int:
    cap = 12 if _WIN32 else 32
    return max(1, min(cap, cfg.poll_concurrency))


def _discovery_concurrency(cfg: EffectivePrinterPollConfig) -> int:
    cap = 12 if _WIN32 else 24
    return max(4, min(cap, cfg.poll_concurrency * 2))


@dataclass
class PrinterPollStats:
    polled: int = 0
    online: int = 0
    offline: int = 0
    skipped: int = 0
    snmp_ok: int = 0
    snmp_error: int = 0
    duration_ms: int = 0
    triggered_by: str = "manual"
    total_in_db: int = 0
    with_ip: int = 0
    without_ip: int = 0
    discovered: int = 0
    discovery_created: int = 0
    discovery_updated: int = 0
    message: str = ""

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)


def format_poll_message(stats: PrinterPollStats) -> str:
    if stats.total_in_db == 0:
        return "SNMP discovery завершён: принтеры не найдены. Проверьте VLAN/фаервол/community/SNMP v2c."
    if stats.with_ip == 0:
        return f"В базе {stats.total_in_db} записей без IP. Удалите мусор или добавьте принтер с IP."
    if stats.polled == 0:
        return f"В базе {stats.total_in_db} принтеров, с IP — {stats.with_ip}, но опрос не выполнен."
    parts = [
        f"SNMP опрос {stats.duration_ms} мс: доступно {stats.online}/{stats.polled}",
        f"SNMP OK {stats.snmp_ok}",
    ]
    if stats.snmp_error:
        parts.append(f"ошибок SNMP {stats.snmp_error}")
    if stats.discovered:
        parts.append(f"найдено discovery {stats.discovered} (+{stats.discovery_created})")
    return ", ".join(parts) + "."


async def ping_ip(ip: str, timeout_ms: int = 1200) -> bool:
    system = platform.system().lower()
    if system == "windows":
        cmd = ["ping", "-n", "1", "-w", str(timeout_ms), ip]
    else:
        sec = max(1, int(round(timeout_ms / 1000)))
        cmd = ["ping", "-c", "1", "-W", str(sec), ip]

    def run() -> bool:
        try:
            # Не text=True: ping на Windows RU отдаёт cp866, UTF-8 decode падает в _readerthread.
            r = subprocess.run(
                cmd,
                capture_output=True,
                timeout=max(2, timeout_ms / 1000 + 1),
            )
            return r.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    return await asyncio.to_thread(run)


async def poll_single_printer(
    row: Printer,
    cfg: EffectivePrinterPollConfig,
    *,
    now: datetime | None = None,
) -> None:
    now = now or datetime.now(timezone.utc)
    ip = (row.ip_address or "").strip()
    if not ip:
        row.snmp_status = "skipped"
        row.snmp_error = "Нет IP"
        return

    if not cfg.snmp_enabled:
        ping_ok = await ping_ip(ip, cfg.ping_timeout_ms)
        row.poll_status = "online" if ping_ok else "offline"
        row.last_poll_at = now
        row.snmp_status = "skipped"
        row.snmp_error = None if ping_ok else "Ping не прошёл; SNMP выключен"
        return

    # SNMP first: быстрее на живых устройствах; многие принтеры режут ICMP.
    snap = await fetch_printer_snmp(
        ip,
        community=cfg.snmp_community,
        timeout=cfg.snmp_timeout_seconds,
    )
    row.last_snmp_at = now
    row.last_poll_at = now
    if not snap.error:
        row.poll_status = "online"
        row.snmp_status = "ok"
        row.snmp_error = None
        if snap.model:
            row.snmp_model = snap.model
            if row.source == "snmp":
                # snmp_model column is 512; keep full model for UI wrapping
                row.name = snap.model.splitlines()[0].strip()[:512] or row.name
        if snap.page_count is not None:
            row.page_count = snap.page_count
        row.supplies_json = json.dumps([s.to_dict() for s in snap.supplies], ensure_ascii=False)
        return

    # SNMP failed — ping only to distinguish offline vs SNMP misconfig.
    ping_ok = await ping_ip(ip, cfg.ping_timeout_ms)
    row.poll_status = "online" if ping_ok else "offline"
    row.snmp_status = "error"
    row.snmp_error = snap.error if ping_ok else f"{snap.error}; ping тоже не прошёл"


async def run_printer_poll_cycle(
    db: AsyncSession,
    *,
    triggered_by: str = "manual",
) -> PrinterPollStats:
    t0 = time.monotonic()
    stats = PrinterPollStats(triggered_by=triggered_by)
    tab = snmp_tab_clause()
    stats.total_in_db = int(await db.scalar(select(func.count()).select_from(Printer).where(tab)) or 0)
    stats.with_ip = int(
        await db.scalar(
            select(func.count())
            .select_from(Printer)
            .where(tab, Printer.ip_address.is_not(None), Printer.ip_address != "")
        )
        or 0
    )
    stats.without_ip = max(0, stats.total_in_db - stats.with_ip)

    cfg = await get_effective_printer_poll_config(db)
    run_discovery = cfg.snmp_enabled and (triggered_by == "manual" or stats.total_in_db == 0)
    if run_discovery:
        discovery = await discover_snmp_printers(
            db,
            community=cfg.snmp_community,
            timeout=min(2.0, max(0.8, cfg.snmp_timeout_seconds)),
            total_budget_seconds=35.0 if triggered_by == "manual" else 30.0,
            concurrency=_discovery_concurrency(cfg),
        )
        stats.discovered = discovery.found
        stats.discovery_created = discovery.created
        stats.discovery_updated = discovery.updated
        stats.total_in_db = int(await db.scalar(select(func.count()).select_from(Printer).where(tab)) or 0)
        stats.with_ip = int(
            await db.scalar(
                select(func.count())
                .select_from(Printer)
                .where(tab, Printer.ip_address.is_not(None), Printer.ip_address != "")
            )
            or 0
        )
        stats.without_ip = max(0, stats.total_in_db - stats.with_ip)

    rows = (
        await db.execute(
            select(Printer)
            .where(tab, Printer.ip_address.is_not(None), Printer.ip_address != "")
            .order_by(Printer.id.asc())
        )
    ).scalars().all()

    now = datetime.now(timezone.utc)

    async def one(row: Printer) -> None:
        ip = (row.ip_address or "").strip()
        if not ip:
            stats.skipped += 1
            return
        await poll_single_printer(row, cfg, now=now)
        stats.polled += 1
        if row.poll_status == "online":
            stats.online += 1
        else:
            stats.offline += 1
        if row.snmp_status == "ok":
            stats.snmp_ok += 1
        elif row.snmp_status == "error":
            stats.snmp_error += 1

    if rows:
        await run_async_pool(rows, one, _poll_concurrency(cfg))

    stats.duration_ms = int((time.monotonic() - t0) * 1000)
    stats.message = format_poll_message(stats)
    cfg_row = await get_printer_poll_config_row(db)
    cfg_row.last_run_at = now
    cfg_row.last_run_summary_json = stats.to_json()
    await db.commit()
    return stats
