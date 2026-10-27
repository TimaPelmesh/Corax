"""LLM-operator may use the cluster API and their own profile, nothing else in the panel."""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.auth import get_current_user
from app.jwtutil import JWTError, decode_token
from app.models import User

LLM_OPERATOR_ROLE = "llm-operator"


def normalized_panel_role(user: User) -> str:
    role = (getattr(user, "role", "") or "").strip().lower()
    if role in {"observer", "editor", "directory", LLM_OPERATOR_ROLE}:
        return role
    return "observer"


def is_llm_operator(user: User) -> bool:
    return not bool(user.is_superuser) and normalized_panel_role(user) == LLM_OPERATOR_ROLE


def can_view_llm(user: User) -> bool:
    if not user.is_active:
        return False
    if user.is_superuser:
        return True
    return normalized_panel_role(user) in {"observer", "editor", LLM_OPERATOR_ROLE}


def can_manage_llm(user: User) -> bool:
    if not user.is_active:
        return False
    if user.is_superuser:
        return True
    return normalized_panel_role(user) in {"editor", LLM_OPERATOR_ROLE}


def llm_operator_path_allowed(method: str, path: str) -> bool:
    verb = (method or "GET").upper()
    raw = (path or "").split("?", 1)[0]
    if raw.startswith("/api/v1/server-audit") or raw.startswith("/api/server-audit"):
        if verb == "GET":
            return True
        return verb == "POST" and raw.rstrip("/").endswith("/ssh")
    if raw.startswith("/api/v1/health") or raw.startswith("/api/health"):
        return True
    if raw.startswith("/api/v1/auth/") or raw == "/api/v1/auth" or raw.startswith("/api/auth/") or raw == "/api/auth":
        return True
    if raw.startswith("/api/v1/llm") or raw.startswith("/api/llm"):
        return True
    if raw in {"/api/v1/users/me", "/api/users/me"} or raw.startswith("/api/v1/users/me/") or raw.startswith("/api/users/me/"):
        return True
    return False


async def get_current_llm_viewer(current: User = Depends(get_current_user)) -> User:
    if not can_view_llm(current):
        raise HTTPException(status_code=403, detail="Недостаточно прав для кластера LLM")
    return current


async def get_current_llm_operator(current: User = Depends(get_current_user)) -> User:
    if not can_manage_llm(current):
        raise HTTPException(status_code=403, detail="Нужна роль LLM-operator, editor или администратор")
    return current


async def llm_operator_block_response(request: Request) -> JSONResponse | None:
    path = request.url.path or ""
    if not path.startswith("/api"):
        return None
    if llm_operator_path_allowed(request.method, path):
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
    if not isinstance(sub, str) or not sub:
        return None
    from app.database import AsyncSessionLocal

    try:
        async with AsyncSessionLocal() as db:
            user = (await db.execute(select(User).where(User.username == sub))).scalar_one_or_none()
            if user is None or int(getattr(user, "token_version", 0) or 0) != token_ver:
                return None
            if not is_llm_operator(user):
                return None
    except Exception:
        return None
    return JSONResponse(
        {"detail": "Роль LLM-operator не открывает остальную панель"},
        status_code=403,
    )


class LlmOperatorScopeMiddleware:
    """Pure ASGI gate. Fleet roles are unchanged; llm-operator stays on /api/v1/llm."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        blocked = await llm_operator_block_response(Request(scope, receive))
        if blocked is not None:
            await blocked(scope, receive, send)
            return
        await self.app(scope, receive, send)
