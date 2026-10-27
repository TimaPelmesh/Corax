"""Server-driven inventory collection: on demand or at a configured local time."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AgentCollectPolicy, AgentCollectRequest

MODES = frozenset({"on_demand", "daily", "weekly"})


@dataclass
class Directive:
    collect: bool
    reason: str
    generation: int
    mode: str
    time_hhmm: str
    weekday: int
    timezone: str
    poll_minutes: int


def _zone(name: str) -> tzinfo:
    key = (name or "").strip() or "Europe/Moscow"
    try:
        return ZoneInfo(key)
    except ZoneInfoNotFoundError:
        # Windows Python without tzdata. Moscow has been UTC+3 year-round since 2014.
        if key in {"Europe/Moscow", "MSK"}:
            return timezone(timedelta(hours=3), name="MSK")
        return timezone.utc


def schedule_slot(policy: AgentCollectPolicy, now: datetime) -> str | None:
    """Return the slot key if `now` is inside the scheduled minute, else None."""
    mode = (policy.mode or "on_demand").strip().lower()
    if mode not in {"daily", "weekly"}:
        return None
    local = now.astimezone(_zone(policy.timezone))
    hhmm = f"{local.hour:02d}:{local.minute:02d}"
    wanted = (policy.time_hhmm or "09:00").strip()
    if len(wanted) >= 5:
        wanted = wanted[:5]
    if hhmm != wanted:
        return None
    if mode == "weekly" and local.weekday() != int(policy.weekday or 0):
        return None
    return local.strftime("%Y-%m-%d") + "T" + wanted


def apply_schedule_bump(policy: AgentCollectPolicy, now: datetime) -> bool:
    slot = schedule_slot(policy, now)
    if not slot or slot == (policy.last_slot or ""):
        return False
    policy.generation = int(policy.generation or 0) + 1
    policy.last_slot = slot
    policy.last_reason = "schedule"
    return True


def directive_for(
    policy: AgentCollectPolicy,
    *,
    seen_generation: int,
    pending: bool,
) -> Directive:
    generation = int(policy.generation or 0)
    if pending:
        collect, reason = True, "now"
    elif seen_generation < generation:
        reason = (policy.last_reason or "now").strip() or "now"
        if reason not in {"now", "schedule"}:
            reason = "now"
        collect = True
    else:
        collect, reason = False, "idle"
    return Directive(
        collect=collect,
        reason=reason,
        generation=generation,
        mode=(policy.mode or "on_demand").strip().lower(),
        time_hhmm=(policy.time_hhmm or "09:00")[:5],
        weekday=int(policy.weekday or 0),
        timezone=(policy.timezone or "Europe/Moscow").strip() or "Europe/Moscow",
        poll_minutes=max(1, min(int(policy.poll_minutes or 5), 60)),
    )


async def get_or_create_policy(db: AsyncSession) -> AgentCollectPolicy:
    row = await db.get(AgentCollectPolicy, 1)
    if row is not None:
        return row
    row = AgentCollectPolicy(
        id=1,
        mode="on_demand",
        time_hhmm="09:00",
        weekday=0,
        timezone="Europe/Moscow",
        generation=0,
        last_slot="",
        last_reason="idle",
        poll_minutes=5,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def host_labels(hostname: str) -> set[str]:
    """Full name and the short label, so Ivanov matches IVANOV.corp."""
    raw = hostname.strip().lower().rstrip(".")
    if not raw:
        return set()
    short = raw.split(".", 1)[0]
    return {raw, short} if short else {raw}


def hostnames_match(left: str, right: str) -> bool:
    a, b = host_labels(left), host_labels(right)
    return bool(a and b and a & b)


async def has_pending(db: AsyncSession, hostname: str) -> bool:
    if not host_labels(hostname):
        return False
    rows = (await db.execute(select(AgentCollectRequest.hostname))).scalars().all()
    return any(hostnames_match(hostname, name) for name in rows)


async def ack_hostname(db: AsyncSession, hostname: str) -> None:
    if not host_labels(hostname):
        return
    rows = (await db.execute(select(AgentCollectRequest.id, AgentCollectRequest.hostname))).all()
    ids = [row.id for row in rows if hostnames_match(hostname, row.hostname)]
    if ids:
        await db.execute(delete(AgentCollectRequest).where(AgentCollectRequest.id.in_(ids)))


async def build_directive(db: AsyncSession, hostname: str, seen_generation: int) -> Directive:
    policy = await get_or_create_policy(db)
    if apply_schedule_bump(policy, datetime.now(_zone(policy.timezone))):
        await db.commit()
        await db.refresh(policy)
    pending = await has_pending(db, hostname)
    return directive_for(policy, seen_generation=seen_generation, pending=pending)
