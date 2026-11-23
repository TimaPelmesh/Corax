"""Per-user Corax Assist access: all / allow-list / deny-list by tags and PCs."""

from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Computer, User
from app.wol_config import _parse_id_list, serialize_id_list

REMOTE_ASSIST_MODES = frozenset({"all", "allow", "deny"})


def normalize_mode(raw: str | None) -> str:
    mode = (raw or "all").strip().lower()
    return mode if mode in REMOTE_ASSIST_MODES else "all"


def tag_ids_of(user: User) -> list[int]:
    return _parse_id_list(getattr(user, "remote_assist_tag_ids_json", None))


def computer_ids_of(user: User) -> list[int]:
    return _parse_id_list(getattr(user, "remote_assist_computer_ids_json", None))


def set_policy(
    user: User,
    *,
    mode: str | None = None,
    tag_ids: list[int] | None = None,
    computer_ids: list[int] | None = None,
) -> None:
    if mode is not None:
        user.remote_assist_mode = normalize_mode(mode)
    if tag_ids is not None:
        user.remote_assist_tag_ids_json = serialize_id_list(tag_ids)
    if computer_ids is not None:
        user.remote_assist_computer_ids_json = serialize_id_list(computer_ids)


def policy_public(user: User) -> dict:
    return {
        "remote_assist_mode": normalize_mode(getattr(user, "remote_assist_mode", None)),
        "remote_assist_tag_ids": tag_ids_of(user),
        "remote_assist_computer_ids": computer_ids_of(user),
    }


def _is_editor(user: User) -> bool:
    if user.is_superuser:
        return True
    role = (user.role or "").strip().lower()
    return role == "editor"


def _hit(computer: Computer, tag_ids: list[int], computer_ids: list[int]) -> bool:
    if computer.id in computer_ids:
        return True
    if not tag_ids:
        return False
    for tag in computer.tags or []:
        if tag.id in tag_ids:
            return True
    return False


async def load_computer_for_assist(
    db: AsyncSession,
    *,
    computer_id: int | None = None,
    hostname: str | None = None,
) -> Computer | None:
    if computer_id and computer_id > 0:
        r = await db.execute(
            select(Computer).options(selectinload(Computer.tags)).where(Computer.id == computer_id)
        )
        return r.scalar_one_or_none()
    host = (hostname or "").strip()
    if not host:
        return None
    key = host.lower()
    short = key.split(".", 1)[0]
    r = await db.execute(
        select(Computer)
        .options(selectinload(Computer.tags))
        .where(
            or_(
                func.lower(Computer.hostname) == key,
                func.lower(Computer.hostname) == short,
                func.lower(Computer.hostname).like(short + ".%"),
            )
        )
        .order_by(Computer.id.asc())
        .limit(1)
    )
    return r.scalar_one_or_none()


async def can_remote_assist(
    db: AsyncSession,
    user: User,
    *,
    computer: Computer | None = None,
    computer_id: int | None = None,
    hostname: str | None = None,
) -> tuple[bool, str]:
    """Return (allowed, reason_code). reason_code empty when allowed."""
    if user.is_superuser:
        return True, ""
    if not _is_editor(user):
        return False, "role"
    mode = normalize_mode(getattr(user, "remote_assist_mode", None))
    if mode == "all":
        return True, ""

    pc = computer
    if pc is None:
        pc = await load_computer_for_assist(db, computer_id=computer_id, hostname=hostname)
    if pc is None:
        # Unknown host: allow-mode must fail closed; deny-mode stays open.
        if mode == "allow":
            return False, "unknown_host"
        return True, ""

    tags = tag_ids_of(user)
    pcs = computer_ids_of(user)
    matched = _hit(pc, tags, pcs)
    if mode == "allow":
        if matched:
            return True, ""
        return False, "not_in_allowlist"
    # deny
    if matched:
        return False, "denied"
    return True, ""


def deny_detail(reason: str) -> str:
    if reason == "role":
        return "Corax Assist доступен только редакторам и администраторам"
    if reason == "unknown_host":
        return "ПК не найден в инвентаре — Assist по вашей политике недоступен"
    if reason == "not_in_allowlist":
        return "Нет права Corax Assist на этот ПК (политика учётки)"
    if reason == "denied":
        return "Corax Assist на этот ПК запрещён политикой учётки"
    return "Нет права Corax Assist на этот ПК"
