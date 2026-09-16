"""First-login bootstrap password must be changed before the panel is usable."""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.config import _is_default_secret, settings
from app.jwtutil import JWTError, decode_token
from app.models import User

PASSWORD_CHANGE_REQUIRED = "password_change_required"

_ALLOWED = {
    ("GET", "/api/v1/auth/me"),
    ("GET", "/api/auth/me"),
    ("POST", "/api/v1/auth/logout"),
    ("POST", "/api/auth/logout"),
    ("POST", "/api/v1/users/me/change-password"),
    ("POST", "/api/users/me/change-password"),
}


def password_change_path_allowed(method: str, path: str) -> bool:
    m = (method or "GET").upper()
    p = path or ""
    if p.startswith("/api/v1/health") or p.startswith("/api/health"):
        return True
    if (m, p) in _ALLOWED:
        return True
    stripped = p.rstrip("/") or p
    return (m, stripped) in _ALLOWED


def is_test_environment() -> bool:
    return (settings.environment or "").strip().lower() == "test"


def bootstrap_must_change_password() -> bool:
    """New bootstrap admin: force change except in automated tests."""
    return not is_test_environment()


def is_forbidden_new_password(new_password: str, current_password: str) -> str | None:
    new = (new_password or "").strip()
    cur = (current_password or "").strip()
    if not new:
        return "Задайте новый пароль"
    if new == cur:
        return "Новый пароль должен отличаться от текущего"
    if is_test_environment():
        return None
    if _is_default_secret(new) or new.lower() in {"admin123", "admin12345"}:
        return "Этот пароль слишком слабый — задайте свой, не лабораторный дефолт"
    return None


async def maybe_flag_bootstrap_password(db, user: User, password: str) -> None:
    """If this is still the lab bootstrap password, lock the panel until it is changed."""
    if is_test_environment() or user is None:
        return
    boot_u = (settings.bootstrap_admin_username or "").strip()
    boot_p = (settings.bootstrap_admin_password or "").strip()
    if not boot_u or not boot_p:
        return
    if user.username.strip().lower() != boot_u.lower():
        return
    if password != boot_p:
        return
    if getattr(user, "must_change_password", False):
        return
    user.must_change_password = True
    await db.commit()
    await db.refresh(user)


async def password_change_block_response(request: Request) -> JSONResponse | None:
    """Return 403 JSON if this session must change password; else None (continue)."""
    path = request.url.path or ""
    if not path.startswith("/api"):
        return None
    if password_change_path_allowed(request.method, path):
        return None

    token = None
    authz = (request.headers.get("authorization") or "").strip()
    if authz.lower().startswith("bearer "):
        token = authz[7:].strip()
    if not token:
        token = (request.cookies.get("access_token") or "").strip() or None
    if not token:
        return None

    try:
        payload = decode_token(token)
        sub = payload.get("sub")
        token_ver = int(payload.get("ver") or 0)
    except (JWTError, TypeError, ValueError):
        return None
    if not sub:
        return None

    from app.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        r = await db.execute(select(User).where(User.username == sub))
        user = r.scalar_one_or_none()
        if user is None or int(getattr(user, "token_version", 0) or 0) != token_ver:
            return None
        if not getattr(user, "must_change_password", False):
            return None

    return JSONResponse({"detail": PASSWORD_CHANGE_REQUIRED}, status_code=403)


class PasswordChangeGateMiddleware:
    """Pure ASGI: no BaseHTTPMiddleware TaskGroup around every request."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive)
        blocked = await password_change_block_response(request)
        if blocked is not None:
            await blocked(scope, receive, send)
            return
        await self.app(scope, receive, send)
