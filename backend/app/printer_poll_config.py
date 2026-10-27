from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import PrinterPollConfig


@dataclass
class EffectivePrinterPollConfig:
    poll_enabled: bool = True
    poll_interval_minutes: int = 60
    snmp_enabled: bool = True
    snmp_community: str = "public"
    snmp_timeout_seconds: float = 3.5
    ping_timeout_ms: int = 1200
    poll_concurrency: int = 10
    last_run_at: object | None = None
    last_run_summary_json: str | None = None


def _clamp_int(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(v)))


async def get_printer_poll_config_row(db: AsyncSession) -> PrinterPollConfig:
    row = (await db.execute(select(PrinterPollConfig).order_by(PrinterPollConfig.id.asc()).limit(1))).scalar_one_or_none()
    if row is None:
        row = PrinterPollConfig()
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


async def get_effective_printer_poll_config(db: AsyncSession) -> EffectivePrinterPollConfig:
    row = await get_printer_poll_config_row(db)
    return EffectivePrinterPollConfig(
        poll_enabled=bool(row.poll_enabled),
        poll_interval_minutes=_clamp_int(row.poll_interval_minutes, 1, 24 * 60),
        snmp_enabled=bool(row.snmp_enabled),
        snmp_community=(row.snmp_community or "public").strip() or "public",
        snmp_timeout_seconds=max(1.0, min(float(row.snmp_timeout_seconds or 3.5), 60.0)),
        ping_timeout_ms=_clamp_int(row.ping_timeout_ms, 300, 10000),
        poll_concurrency=_clamp_int(row.poll_concurrency or 10, 1, 32),
        last_run_at=row.last_run_at,
        last_run_summary_json=row.last_run_summary_json,
    )
