from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_superuser, hash_password
from app.database import get_db
from app.models import Bitrix24Config, ServiceRequest, User
from app.schemas import Bitrix24IncomingRequest

router = APIRouter(prefix="/integrations/bitrix24", tags=["bitrix24-incoming"])


async def _get_or_create_cfg(db: AsyncSession) -> Bitrix24Config:
    row = await db.get(Bitrix24Config, 1)
    if row is None:
        row = Bitrix24Config(
            id=1,
            enabled=False,
            incoming_secret=secrets.token_urlsafe(24),
            default_priority="normal",
            default_category="bitrix24",
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


async def _get_or_create_bot_user(db: AsyncSession) -> User:
    username = "bitrix-bot"
    r = await db.execute(select(User).where(User.username == username).limit(1))
    row = r.scalar_one_or_none()
    if row is not None:
        return row
    pwd = secrets.token_urlsafe(24)
    row = User(
        username=username,
        email=None,
        full_name="Bitrix24 Bot",
        hashed_password=hash_password(pwd),
        is_active=True,
        is_superuser=False,
        is_ldap=False,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _to_text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    try:
        return json.dumps(v, ensure_ascii=False)
    except Exception:
        return str(v)


def _normalize_incoming(payload: dict[str, Any]) -> Bitrix24IncomingRequest:
    # Accept both a clean custom JSON and "anything Bitrix sends" with best-effort mapping.
    title = _to_text(payload.get("title") or "").strip() or None
    text = _to_text(payload.get("text") or payload.get("message") or payload.get("body") or "").strip() or None
    description = _to_text(payload.get("description") or "").strip() or None
    requester = _to_text(payload.get("requester_name") or payload.get("from") or payload.get("user") or "").strip() or None
    location = _to_text(payload.get("location") or "").strip() or None
    category = _to_text(payload.get("category") or "").strip() or None
    priority = _to_text(payload.get("priority") or "").strip() or None
    external_id = _to_text(payload.get("external_id") or payload.get("id") or payload.get("message_id") or "").strip() or None
    external_url = _to_text(payload.get("external_url") or payload.get("url") or "").strip() or None

    return Bitrix24IncomingRequest(
        title=title,
        text=text,
        description=description,
        requester_name=requester,
        location=location,
        category=category,
        priority=priority,
        external_id=external_id,
        external_url=external_url,
    )


def _build_title(n: Bitrix24IncomingRequest) -> str:
    if n.title:
        t = n.title.strip()
    elif n.text:
        t = n.text.strip().splitlines()[0].strip()
    else:
        t = "Заявка из Bitrix24"
    if not t:
        t = "Заявка из Bitrix24"
    if len(t) > 255:
        t = t[:252] + "..."
    return t


def _build_description(n: Bitrix24IncomingRequest, raw_payload_json: str | None) -> str | None:
    parts: list[str] = []
    if n.description:
        parts.append(n.description.strip())
    if n.text and (not n.description or n.text.strip() != n.description.strip()):
        parts.append(n.text.strip())
    meta: list[str] = []
    if n.external_url:
        meta.append(f"Bitrix24 URL: {n.external_url}")
    if n.external_id:
        meta.append(f"Bitrix24 ID: {n.external_id}")
    if meta:
        parts.append("\n".join(meta))
    if raw_payload_json:
        # Keep it bounded to avoid blowing up the DB.
        cap = 80_000
        trimmed = raw_payload_json if len(raw_payload_json) <= cap else raw_payload_json[:cap] + "\n...trimmed..."
        parts.append("RAW:\n" + trimmed)
    text = "\n\n".join([p for p in parts if p]).strip()
    return text or None


def _verify_secret(cfg: Bitrix24Config, secret: str | None) -> None:
    if not cfg.enabled:
        raise HTTPException(status_code=403, detail="Bitrix24 integration is disabled")
    expected = (cfg.incoming_secret or "").strip()
    got = (secret or "").strip()
    if not expected or not got or not secrets.compare_digest(expected, got):
        raise HTTPException(status_code=403, detail="Invalid integration secret")


@router.post("/incoming")
async def incoming(
    request: Request,
    db: AsyncSession = Depends(get_db),
    secret: str | None = Query(default=None),
    x_integration_secret: str | None = Header(default=None, alias="X-Integration-Secret"),
):
    cfg = await _get_or_create_cfg(db)
    _verify_secret(cfg, x_integration_secret or secret)

    raw_text = ""
    payload: dict[str, Any] = {}
    raw_payload_json: str | None = None

    ctype = (request.headers.get("content-type") or "").lower()
    try:
        if "application/json" in ctype:
            payload_any = await request.json()
            if isinstance(payload_any, dict):
                payload = payload_any
            else:
                payload = {"payload": payload_any}
        elif "application/x-www-form-urlencoded" in ctype or "multipart/form-data" in ctype:
            form = await request.form()
            payload = {k: v for k, v in form.items()}
        else:
            raw_text = (await request.body()).decode("utf-8", errors="replace")
            payload = {"text": raw_text}
    except Exception:
        raw_text = (await request.body()).decode("utf-8", errors="replace")
        payload = {"text": raw_text}

    try:
        raw_payload_json = json.dumps(payload, ensure_ascii=False)
    except Exception:
        raw_payload_json = None

    norm = _normalize_incoming(payload)
    bot_user = await _get_or_create_bot_user(db)

    now = datetime.now(timezone.utc)
    row = ServiceRequest(
        title=_build_title(norm),
        description=_build_description(norm, raw_payload_json),
        status="open",
        priority=(norm.priority or cfg.default_priority or "normal"),
        requester_name=(norm.requester_name.strip() if norm.requester_name else None),
        category=(norm.category.strip() if norm.category else (cfg.default_category or "bitrix24")),
        location=(norm.location.strip() if norm.location else None),
        created_by_id=bot_user.id,
        opened_at=now,
        external_source="bitrix24",
        external_id=(norm.external_id.strip() if norm.external_id else None),
        external_url=(norm.external_url.strip() if norm.external_url else None),
        external_payload_json=raw_payload_json,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return {"ok": True, "request_id": row.id}


@router.post("/incoming/test")
async def incoming_test(
    body: Bitrix24IncomingRequest,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    cfg = await _get_or_create_cfg(db)
    bot_user = await _get_or_create_bot_user(db)
    now = datetime.now(timezone.utc)
    row = ServiceRequest(
        title=_build_title(body),
        description=_build_description(body, raw_payload_json=None),
        status="open",
        priority=(body.priority or cfg.default_priority or "normal"),
        requester_name=(body.requester_name.strip() if body.requester_name else None),
        category=(body.category.strip() if body.category else (cfg.default_category or "bitrix24")),
        location=(body.location.strip() if body.location else None),
        created_by_id=bot_user.id,
        opened_at=now,
        external_source="bitrix24",
        external_id=(body.external_id.strip() if body.external_id else None),
        external_url=(body.external_url.strip() if body.external_url else None),
        external_payload_json=None,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return {"ok": True, "request_id": row.id}

