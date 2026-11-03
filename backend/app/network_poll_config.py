from __future__ import annotations

import ipaddress
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
    ping_cidr_list: list[str] = field(default_factory=list)
    ping_prefix: int = 24
    ping_timeout_ms: int = 1000
    ping_gap_ms: float = 1.0
    last_run_at: object | None = None
    last_run_summary_json: str | None = None


def _clamp_int(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(v)))


class PingCidrError(ValueError):
    def __init__(self, token: str) -> None:
        self.token = token
        super().__init__(token)


def normalize_ping_cidrs(raw: list[str], prefix: int) -> list[str]:
    """Сети быстрого пинга. Адрес без маски получает выбранный префикс."""
    prefix = _clamp_int(prefix, 16, 30)
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        token = str(item or "").strip()
        if not token:
            continue
        try:
            if "/" in token:
                net = ipaddress.ip_network(token, strict=False)
            else:
                addr = ipaddress.ip_address(token)
                if not isinstance(addr, ipaddress.IPv4Address):
                    raise ValueError
                net = ipaddress.ip_network(f"{addr}/{prefix}", strict=False)
        except ValueError as e:
            raise PingCidrError(token) from e
        if not isinstance(net, ipaddress.IPv4Network):
            raise PingCidrError(token)
        if not (net.is_private or net.is_link_local):
            raise PingCidrError(token)
        if net.prefixlen < 16 or net.prefixlen > 30:
            raise PingCidrError(token)
        text = str(net)
        if text not in seen:
            seen.add(text)
            out.append(text)
    return out


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
        ping_cidr_list=parse_cidr_list(getattr(row, "ping_cidr_json", None)),
        ping_prefix=_clamp_int(getattr(row, "ping_prefix", None) or 24, 16, 30),
        ping_timeout_ms=_clamp_int(getattr(row, "ping_timeout_ms", None) or 1000, 500, 2000),
        ping_gap_ms=max(0.5, min(float(getattr(row, "ping_gap_ms", None) or 1.0), 20.0)),
        last_run_at=row.last_run_at,
        last_run_summary_json=row.last_run_summary_json,
    )
