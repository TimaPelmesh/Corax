"""Hide integration secrets from observer-role panel users."""

from __future__ import annotations

from app.models import User

_MASK = "********"


def can_read_integration_secrets(user: User | None) -> bool:
    if user is None:
        return False
    if user.is_superuser:
        return True
    role = (getattr(user, "role", "") or "").strip().lower()
    return role == "editor"


def mask_secret(value: str | None, *, reveal: bool) -> str:
    raw = (value or "").strip()
    if reveal:
        return raw
    return _MASK if raw else ""
