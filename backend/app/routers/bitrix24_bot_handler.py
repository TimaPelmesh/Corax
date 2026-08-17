from __future__ import annotations

import json
from pathlib import Path
import re
import secrets
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import hash_password
from app.config import settings
from app.database import get_db
from app.models import Bitrix24Config, ServiceRequest, User

router = APIRouter()


_BRACKET_RE = re.compile(r"([^\[\]]+)|\[([^\]]*)\]")


def _split_key(key: str) -> list[str]:
    parts: list[str] = []
    for m in _BRACKET_RE.finditer(key):
        a = m.group(1)
        b = m.group(2)
        token = a if a is not None else b
        if token is None or token == "":
            continue
        parts.append(token)
    return parts or [key]


def _set_nested(root: dict[str, Any], parts: list[str], value: Any) -> None:
    cur: dict[str, Any] = root
    for p in parts[:-1]:
        nxt = cur.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[p] = nxt
        cur = nxt
    cur[parts[-1]] = value


def _expand_form(flat: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in flat.items():
        _set_nested(out, _split_key(k), v)
    return out


def _first_str(*vals: Any) -> str | None:
    for v in vals:
        if v is None:
            continue
        if isinstance(v, str):
            t = v.strip()
            if t:
                return t
        else:
            try:
                t = str(v).strip()
                if t:
                    return t
            except Exception:
                continue
    return None


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


def _b24_webhook_base() -> str:
    base = (settings.bitrix24_bot_webhook_url or settings.bitrix24_webhook_url or "").strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=400, detail="BITRIX24_WEBHOOK_URL не задан (нужен для ответа бота).")
    if not base.startswith("http"):
        raise HTTPException(status_code=400, detail="BITRIX24_WEBHOOK_URL должен начинаться с http(s)://")
    return base


async def _b24_call(method: str, params: dict[str, Any]) -> dict[str, Any]:
    base = _b24_webhook_base()
    url = f"{base}/{method}.json"
    timeout = httpx.Timeout(20.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(url, data=params)
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Bitrix24 HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Bitrix24: неожиданный ответ")
    if data.get("error"):
        # Keep original error for debugging; do not expose secrets.
        raise HTTPException(status_code=502, detail=f"Bitrix24 error: {data.get('error')} {data.get('error_description')}")
    return data


async def _b24_user_display_name(user_id: int) -> str | None:
    try:
        data = await _b24_call("im.user.get", {"ID": str(user_id)})
    except Exception:
        return None
    res = data.get("result")
    if not isinstance(res, dict):
        return None
    # Prefer first_name for greeting; fallback to name.
    first = str(res.get("first_name") or "").strip()
    if first:
        return first
    name = str(res.get("name") or "").strip()
    return name or None


def _mention_user(user_id: int, label: str) -> str:
    # Bitrix IM supports BB-codes in MESSAGE; user mention is commonly done with [USER=id]Name[/USER].
    safe = (label or "").strip() or "пользователь"
    return f"[USER={user_id}]{safe}[/USER]"


def _verify_handler_token(handler_token: str | None, header_token: str | None) -> None:
    expected = (settings.bitrix24_bot_handler_token or "").strip()
    if not expected:
        raise HTTPException(status_code=500, detail="BITRIX24_BOT_HANDLER_TOKEN не задан на сервере.")
    got = (header_token or handler_token or "").strip()
    if not got or not secrets.compare_digest(expected, got):
        raise HTTPException(status_code=403, detail="Invalid handler token")


def _save_bot_inbox(obj: dict[str, Any], when: datetime) -> None:
    base = (settings.bitrix24_bot_inbox_dir or "").strip()
    if not base:
        return
    p = Path(base)
    if not p.is_absolute():
        p = Path(__file__).resolve().parent.parent.parent / p
    p.mkdir(parents=True, exist_ok=True)
    name = f"b24_{when:%Y%m%dT%H%M%S_%f}.json"
    tmp = f"{name}.tmp"
    try:
        raw_json = json.dumps(obj, ensure_ascii=False, indent=2)
        (p / tmp).write_text(raw_json, encoding="utf-8")
        (p / tmp).replace(p / name)
    except OSError:
        pass


def _save_bot_outbox(obj: dict[str, Any], when: datetime) -> None:
    base = (settings.bitrix24_bot_inbox_dir or "").strip()
    if not base:
        return
    p = Path(base)
    if not p.is_absolute():
        p = Path(__file__).resolve().parent.parent.parent / p
    p.mkdir(parents=True, exist_ok=True)
    name = f"b24_reply_{when:%Y%m%dT%H%M%S_%f}.json"
    tmp = f"{name}.tmp"
    try:
        raw_json = json.dumps(obj, ensure_ascii=False, indent=2)
        (p / tmp).write_text(raw_json, encoding="utf-8")
        (p / tmp).replace(p / name)
    except OSError:
        pass


async def _get_or_create_cfg(db: AsyncSession) -> Bitrix24Config:
    row = await db.get(Bitrix24Config, 1)
    if row is None:
        # Mirror logic from settings router: default disabled.
        row = Bitrix24Config(id=1, enabled=False, incoming_secret=secrets.token_urlsafe(24), default_priority="normal", default_category="bitrix24")
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


@router.api_route("/handler", methods=["GET", "POST"])
async def handler(
    request: Request,
    db: AsyncSession = Depends(get_db),
    token: str | None = Query(default=None),
    x_handler_token: str | None = Header(default=None, alias="X-Handler-Token"),
    debug: int = Query(default=0),
):
    # Security: accept only requests with shared token (configured in Bitrix "handler URL").
    _verify_handler_token(token, x_handler_token)

    # NOTE: For the bot handler we do NOT gate behavior by Bitrix24Config.enabled.
    # That flag is meant for the "incoming webhook" integration page, while the bot
    # should still be able to reply and create requests when configured via .env.
    cfg = await _get_or_create_cfg(db)

    if request.method.upper() == "GET":
        return {"ok": True}

    # Read raw body early for reliable logging (even if parsing fails).
    raw_body_bytes = await request.body()
    raw_body_text = raw_body_bytes.decode("utf-8", errors="replace") if raw_body_bytes else ""

    ctype = (request.headers.get("content-type") or "").lower()
    payload: dict[str, Any] = {}
    flat: dict[str, Any] = {}
    raw_payload_json: str | None = None

    try:
        if "application/json" in ctype:
            data_any = await request.json()
            if isinstance(data_any, dict):
                payload = data_any
            else:
                payload = {"payload": data_any}
        else:
            form = await request.form()
            flat = {str(k): (str(v) if v is not None else "") for k, v in form.items()}
            payload = _expand_form(flat)
    except Exception:
        payload = {"text": raw_body_text}

    try:
        raw_payload_json = json.dumps(payload, ensure_ascii=False)
    except Exception:
        raw_payload_json = None
    _save_bot_inbox(
        {
            "received_at": datetime.now(timezone.utc).isoformat(),
            "content_type": ctype,
            "headers": {k: v for k, v in request.headers.items()},
            "raw_body": raw_body_text,
            "parsed": payload,
        },
        datetime.now(timezone.utc),
    )

    # Bitrix typically sends `event` and nested `data[PARAMS][...]`.
    event = _first_str(payload.get("event"), payload.get("EVENT"))
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    params = data.get("PARAMS") if isinstance(data.get("PARAMS"), dict) else data.get("params") if isinstance(data.get("params"), dict) else {}

    msg_text = _first_str(
        params.get("MESSAGE"),
        params.get("MESSAGE_TEXT"),
        params.get("TEXT"),
        payload.get("text"),
        payload.get("message"),
        payload.get("body"),
    )
    chat_id_raw = _first_str(params.get("CHAT_ID"), params.get("CHATID"), payload.get("chat_id"))
    dialog_id = _first_str(params.get("DIALOG_ID"), params.get("DIALOGID"), payload.get("dialog_id")) or chat_id_raw or _first_str(params.get("FROM_USER_ID"))
    from_user_id_raw = _first_str(
        params.get("FROM_USER_ID"),
        params.get("AUTHOR_ID"),
        params.get("USER_ID"),
        payload.get("from_user_id"),
        payload.get("user_id"),
    )
    external_id = _first_str(params.get("MESSAGE_ID"), params.get("ID"), payload.get("id"))

    if not msg_text:
        # Still return OK: Bitrix sometimes pings handler with non-message events.
        return {"ok": True, "event": event or "unknown", "note": "no message"}

    # Create local service request.
    bot_user = await _get_or_create_bot_user(db)
    now = datetime.now(timezone.utc)
    title = msg_text.strip().splitlines()[0].strip() or "Заявка из Bitrix24"
    if len(title) > 255:
        title = title[:252] + "..."
    requester_name: str | None = None
    mention: str | None = None
    from_user_id: int | None = None
    if from_user_id_raw and str(from_user_id_raw).strip().isdigit():
        try:
            from_user_id = int(str(from_user_id_raw).strip())
        except Exception:
            from_user_id = None
    if from_user_id:
        display = await _b24_user_display_name(from_user_id)
        if display:
            requester_name = display
            mention = _mention_user(from_user_id, display)

    row = ServiceRequest(
        title=title,
        description=msg_text.strip(),
        status="open",
        priority=(cfg.default_priority if cfg is not None and cfg.default_priority else "normal"),
        requester_name=requester_name,
        category=(cfg.default_category if cfg is not None and cfg.default_category else "bitrix24"),
        location=None,
        created_by_id=bot_user.id,
        opened_at=now,
        external_source="bitrix24",
        external_id=external_id,
        external_url=None,
        external_payload_json=raw_payload_json,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    # Reply back to the same dialog if possible.
    reply: dict[str, Any] | None = None
    reply_error: str | None = None
    if dialog_id and settings.bitrix24_bot_id and settings.bitrix24_bot_client_id:
        try:
            # Doc (MCP): dialogId = chat{chatId} for group chats, {userId} for private.
            dialog_norm = None
            if chat_id_raw and str(chat_id_raw).strip().isdigit():
                dialog_norm = f"chat{int(str(chat_id_raw).strip())}"
            else:
                d = str(dialog_id).strip()
                if d.lower().startswith("chat"):
                    dialog_norm = d
                elif d.isdigit():
                    dialog_norm = d
            if not dialog_norm:
                raise RuntimeError("dialog_id missing")

            greet_name = mention or "пользователь"
            keyboard = {
                "BOT_ID": str(settings.bitrix24_bot_id),
                "BUTTONS": [
                    [
                        {
                            "TEXT": "Открыть заявки",
                            "BG_COLOR": "#EDEEF0",
                            "TEXT_COLOR": "#222",
                            "LINK": "http://127.0.0.1:3000/service-requests",
                        }
                    ]
                ],
            }
            reply = await _b24_call(
                "imbot.message.add",
                {
                    "BOT_ID": str(settings.bitrix24_bot_id),
                    "CLIENT_ID": settings.bitrix24_bot_client_id,
                    "DIALOG_ID": dialog_norm,
                    "MESSAGE": f"Здравствуйте, {greet_name}! ✅ Заявка создана #{row.id}",
                    # Bitrix expects KEYBOARD as JSON string.
                    "KEYBOARD": json.dumps(keyboard, ensure_ascii=False),
                },
            )
        except Exception as exc:
            # Do not fail the handler if reply fails: request creation is the main goal.
            msg = str(exc) or "reply_failed"
            reply_error = msg[:300]
            if debug:
                try:
                    print(f"[b24-bot] reply failed: dialog_id={dialog_id} chat_id={chat_id_raw}", flush=True)
                except Exception:
                    pass

    _save_bot_outbox(
        {
            "when": datetime.now(timezone.utc).isoformat(),
            "request_id": row.id,
            "event": event,
            "dialog_id": dialog_id,
            "chat_id": chat_id_raw,
            "from_user_id": from_user_id_raw,
            "reply_error": reply_error,
            "reply": reply,
        },
        datetime.now(timezone.utc),
    )

    out = {"ok": True, "request_id": row.id}
    if debug:
        out["event"] = event
        out["dialog_id"] = dialog_id
        out["external_id"] = external_id
        out["reply_error"] = reply_error
        out["reply"] = reply
    return out

