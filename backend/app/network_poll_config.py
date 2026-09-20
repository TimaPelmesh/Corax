from __future__ import annotations

import json
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import NetworkPollConfig


@dataclass
class EffectiveNetworkPollConfig:
    poll_enabled: bool = False
    poll_interval_minutes: int = 120
    snmp_community: str = "public"
    snmp_timeout_seconds: float = 3.5
    poll_concurrency: int = 8
    cidr_list: list[str] = field(default_factory=list)
    last_run_at: object | None = None
    last_run_summary_json: str | None = None


def _clamp_int(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(v)))


def parse_cidr_list(raw: str | None) -> list[str]:
    if not raw or not str(raw).strip():
        return []
    text = str(raw).strip()
    if text.startswith("["):
        try:
            data = json.loads(text)
            if isinstance(data, list):
                return [str(x).strip() for x in data if str(x).strip()]
        except json.JSONDecodeError:
            pass
    return [p.strip() for p in text.replace(";", ",").replace("\n", ",").split(",") if p.strip()]


async def get_network_poll_config_row(db: AsyncSession) -> NetworkPollConfig:
    row = (
        await db.execute(select(NetworkPollConfig).order_by(NetworkPollConfig.id.asc()).limit(1))
    ).scalar_one_or_none()
    if row is None:
        row = NetworkPollConfig()
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


async def get_effective_network_poll_config(db: AsyncSession) -> EffectiveNetworkPollConfig:
    row = await get_network_poll_config_row(db)
    return EffectiveNetworkPollConfig(
        poll_enabled=bool(row.poll_enabled),
        poll_interval_minutes=_clamp_int(row.poll_interval_minutes, 5, 24 * 60),
        snmp_community=(row.snmp_community or "public").strip() or "public",
        snmp_timeout_seconds=max(1.0, min(float(row.snmp_timeout_seconds or 3.5), 60.0)),
        poll_concurrency=_clamp_int(row.poll_concurrency or 8, 1, 48),
        cidr_list=parse_cidr_list(row.cidr_list_json),
        last_run_at=row.last_run_at,
        last_run_summary_json=row.last_run_summary_json,
    )
