"""Wake-on-LAN panel config (allowlist + operators + kill-switches)."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import User, WakeOnLanConfig

_cooldown_lock = threading.Lock()
_last_wake_monotonic: dict[int, float] = {}


@dataclass
class EffectiveWolConfig:
    enabled: bool
    allowlist: list[int]
    wake_user_ids: list[int]
    cooldown_seconds: int
    force_disabled: bool


def _parse_id_list(raw: str | None) -> list[int]:
    if not raw or not str(raw).strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[int] = []
    seen: set[int] = set()
    for x in data:
        try:
            i = int(x)
        except (TypeError, ValueError):
            continue
        if i <= 0 or i in seen:
            continue
        seen.add(i)
        out.append(i)
        if len(out) >= 500:
            break
    return sorted(out)


def serialize_id_list(ids: list[int]) -> str:
    cleaned = _parse_id_list(json.dumps(ids))
    return json.dumps(cleaned, ensure_ascii=False)


# Back-compat aliases used by routers/tests
serialize_allowlist = serialize_id_list


async def get_wol_config_row(db: AsyncSession) -> WakeOnLanConfig:
    row = (
        await db.execute(select(WakeOnLanConfig).order_by(WakeOnLanConfig.id.asc()).limit(1))
    ).scalar_one_or_none()
    if row is None:
        row = WakeOnLanConfig(
            enabled=False,
            allowlist_computer_ids_json="[]",
            wake_user_ids_json="[]",
            cooldown_seconds=0,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


async def get_effective_wol_config(db: AsyncSession) -> EffectiveWolConfig:
    row = await get_wol_config_row(db)
    force = bool(getattr(settings, "wol_force_disabled", False))
    # 0 = no per-PC pause (admin may still use API rate limit). Previously forced ≥30s.
    cooldown = max(0, min(int(row.cooldown_seconds or 0), 3600))
    wake_users_raw = getattr(row, "wake_user_ids_json", None) or "[]"
    # Feature is always available unless server kill-switch; no scary DB "enable" gate.
    return EffectiveWolConfig(
        enabled=not force,
        allowlist=_parse_id_list(row.allowlist_computer_ids_json),
        wake_user_ids=_parse_id_list(wake_users_raw),
        cooldown_seconds=cooldown,
        force_disabled=force,
    )


def is_computer_allowlisted(cfg: EffectiveWolConfig, computer_id: int) -> bool:
    return int(computer_id) in set(cfg.allowlist)


def user_may_wake(user: User, cfg: EffectiveWolConfig) -> bool:
    """Superuser always; others only if explicitly granted in Settings."""
    if not user.is_active:
        return False
    if user.is_superuser:
        return True
    return int(user.id) in set(cfg.wake_user_ids)


def check_cooldown(computer_id: int, cooldown_seconds: int) -> int | None:
    """Return remaining seconds if cooling down, else None. cooldown_seconds≤0 disables."""
    cd = int(cooldown_seconds or 0)
    if cd <= 0:
        return None
    with _cooldown_lock:
        last = _last_wake_monotonic.get(int(computer_id))
        if last is None:
            return None
        elapsed = time.monotonic() - last
        left = int(cd - elapsed)
        return left if left > 0 else None


def mark_woken(computer_id: int) -> None:
    with _cooldown_lock:
        _last_wake_monotonic[int(computer_id)] = time.monotonic()
        if len(_last_wake_monotonic) > 2000:
            oldest = sorted(_last_wake_monotonic.items(), key=lambda kv: kv[1])[:500]
            for cid, _ in oldest:
                _last_wake_monotonic.pop(cid, None)
