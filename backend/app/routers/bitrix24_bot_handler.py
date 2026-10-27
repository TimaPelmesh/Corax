from __future__ import annotations

import json
import logging
from pathlib import Path
import re
import secrets
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import hash_password
from app.bot_intake import (
    LEAVE,
    MINE,
    BotVoice,
    accepted_text,
    ask_text,
    bitrix_title,
    cancel_text,
    given_name,
    greeting_text,
    help_text,
    intake_step,
    nudge_text,
    off_text,
    phrases_for_bot,
    status_text,
    voice_from_phrases,
)
from app.config import settings
from app.database import get_db
from app.imbot_v2 import ImbotError, call as imbot_call
from app.imbot_v2 import (
    MENU_COMMANDS,
    attach_keyboard,
    command_register_body,
    dialog_candidates,
    keyboard_sig,
    parse_v2_event,
    send_keyboard,
    webhook_base,
)
from app.models import Bitrix24Config, BitrixBotDialog, ServiceRequest, User, service_request_assignees
from app.search_index import index_service_request

router = APIRouter()
log = logging.getLogger("corax.bitrix.bot")


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


def _payload_from_body(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {}
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}
    parsed = parse_qs(text, keep_blank_values=True)
    flat = {key: values[-1] if values else "" for key, values in parsed.items()}
    return _expand_form(flat)


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


def _token_matches(expected: str, got: str) -> bool:
    import hashlib
    import hmac as hmac_mod

    left = hashlib.sha256(expected.encode("utf-8")).digest()
    right = hashlib.sha256(got.encode("utf-8")).digest()
    return hmac_mod.compare_digest(left, right)


def _verify_handler_token(handler_token: str | None, header_token: str | None, *extra: str) -> None:
    expected = [item.strip() for item in (settings.bitrix24_bot_handler_token, *extra) if (item or "").strip()]
    if not expected:
        raise HTTPException(status_code=403, detail="Bitrix handler is not configured")
    got = (header_token or handler_token or "").strip()
    if not got or not any(_token_matches(item, got) for item in expected):
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


async def _dialog_phase(db: AsyncSession, dialog_id: str) -> str:
    row = await db.get(BitrixBotDialog, dialog_id[:64])
    return (row.phase if row is not None else "") or "idle"


async def _set_dialog_phase(db: AsyncSession, dialog_id: str, phase: str) -> None:
    key = dialog_id[:64]
    row = await db.get(BitrixBotDialog, key)
    now = datetime.now(timezone.utc)
    if row is None:
        db.add(BitrixBotDialog(dialog_id=key, phase=phase, updated_at=now))
    else:
        row.phase = phase
        row.updated_at = now


async def _assign_panel_users(db: AsyncSession, request_id: int) -> None:
    """Editors and administrators see the new ticket in the bell."""
    users = (
        await db.scalars(select(User).where(User.is_active.is_(True), User.username != "bitrix-bot"))
    ).all()
    for user in users:
        if not (user.is_superuser or (user.role or "") == "editor"):
            continue
        await db.execute(
            service_request_assignees.insert().values(request_id=request_id, user_id=user.id)
        )


async def _open_bitrix_ticket(db: AsyncSession, cfg: Bitrix24Config, event: dict[str, str], text: str) -> ServiceRequest:
    external_id = event["message_id"] or None
    if external_id:
        existing = await db.scalar(
            select(ServiceRequest)
            .where(ServiceRequest.external_source == "bitrix24", ServiceRequest.external_id == external_id)
            .limit(1)
        )
        if existing is not None:
            return existing
    bot_user = await _get_or_create_bot_user(db)
    title = bitrix_title(text)
    row = ServiceRequest(
        title=title,
        description=text,
        status="open",
        priority=(cfg.default_priority or "normal"),
        requester_name=event["user_name"] or None,
        category=None,
        location=None,
        created_by_id=bot_user.id,
        opened_at=datetime.now(timezone.utc),
        external_source="bitrix24",
        external_id=external_id,
        external_url=None,
        external_payload_json=json.dumps(
            {"user_id": event.get("user_id") or "", "dialog_id": event.get("dialog_id") or ""},
            ensure_ascii=False,
        ),
    )
    db.add(row)
    await db.flush()
    guessed = await _guess_category(db, row.title, row.description or "")
    if guessed:
        row.category = guessed
    await _assign_panel_users(db, row.id)
    try:
        await index_service_request(db, row)
    except Exception:
        pass
    return row


def _bot_talks(cfg: Bitrix24Config) -> bool:
    """A connected bot answers until the admin pauses it."""
    return bool(cfg.bot_id) and not bool(cfg.bot_paused)


def _phase_key(event: dict[str, str]) -> str:
    """The working bot remembers the button press per person, not per chat."""
    user_id = (event.get("user_id") or "").strip()
    if user_id:
        return ("user:" + user_id)[:64]
    return (event.get("dialog_id") or "")[:64]


def _menu() -> list[dict[str, str]]:
    return send_keyboard(LEAVE, MINE)


async def publish_menu(cfg: Bitrix24Config) -> bool:
    """Register the commands Bitrix lists under the chat + button. Register is idempotent."""
    webhook = (cfg.bot_webhook_url or "").strip()
    token = (cfg.bot_token or "").strip()
    if not cfg.bot_id or not webhook or not token:
        return False
    ok = True
    for command, ru, en in MENU_COMMANDS:
        try:
            await imbot_call(
                webhook,
                "imbot.v2.Command.register",
                command_register_body(int(cfg.bot_id), token, command, ru, en),
            )
        except ImbotError as exc:
            ok = False
            log.warning("bitrix command register failed command=%s code=%s", command, exc.code)
    return ok


def _voice(cfg: Bitrix24Config) -> BotVoice:
    return voice_from_phrases(
        phrases_for_bot(
            cfg.bot_scripts_json,
            cfg.bot_id,
            greet_daypart=cfg.bot_greet_daypart is not False,
            greeting_note=cfg.bot_greeting_note or "",
            close_notice=cfg.bot_close_notice is not False,
        )
    )


def _ticket_payload(row: ServiceRequest) -> dict[str, Any]:
    try:
        loaded = json.loads(row.external_payload_json or "{}")
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


async def _guess_category(db: AsyncSession, title: str, description: str) -> str | None:
    """Keyword category from the ticket text. Empty when nothing in the tree matches."""
    try:
        from app.ticket_handler_runtime import _load_category_paths, classify_category_fast

        paths = await _load_category_paths(db)
        return classify_category_fast(title, description, paths)
    except Exception:
        log.warning("bitrix category guess failed")
        return None


async def _last_bitrix_ticket(db: AsyncSession, event: dict[str, str]) -> ServiceRequest | None:
    user_id = (event.get("user_id") or "").strip()
    dialog_id = (event.get("dialog_id") or "").strip()
    name = given_name(event.get("user_name") or "").casefold()
    rows = (
        await db.scalars(
            select(ServiceRequest)
            .where(ServiceRequest.external_source == "bitrix24")
            .order_by(ServiceRequest.id.desc())
            .limit(200)
        )
    ).all()
    by_dialog: ServiceRequest | None = None
    by_name: ServiceRequest | None = None
    for row in rows:
        payload = _ticket_payload(row)
        if user_id and str(payload.get("user_id") or "") == user_id:
            return row
        if by_dialog is None and dialog_id and str(payload.get("dialog_id") or "") == dialog_id:
            by_dialog = row
        if by_name is None and name and given_name(row.requester_name or "").casefold() == name:
            by_name = row
    return by_dialog or by_name


async def _handle_v2(db: AsyncSession, cfg: Bitrix24Config, event: dict[str, str]) -> dict[str, Any]:
    """Chat events from imbot.v2.Event.get and from the older ONIMBOT* form."""
    stored_id = str(cfg.bot_id or "").strip()
    if stored_id and event["bot_id"] and event["bot_id"] != stored_id:
        return {"ok": True, "note": "other bot"}
    if event.get("from_bot") == "1" or (event.get("user_id") and event["user_id"] == stored_id):
        return {"ok": True, "note": "own message"}
    dialogs = dialog_candidates(event)
    if not dialogs:
        log.warning("bitrix event without dialog event=%s", event["event"])
        return {"ok": True, "event": event["event"], "note": "no dialog"}
    phase_key = _phase_key(event) or dialogs[0]
    waiting = (await _dialog_phase(db, phase_key)) == "await_text"
    step = intake_step(
        event["event"],
        event.get("command") or "",
        event.get("text") or "",
        enabled=_bot_talks(cfg),
        waiting=waiting,
    )
    if step == "skip":
        return {"ok": True, "event": event["event"], "note": step}
    fresh = await db.get(Bitrix24Config, 1, populate_existing=True)
    if fresh is not None:
        cfg = fresh
    voice = _voice(cfg)
    if step == "off":
        await _v2_reply(cfg, event, off_text(voice), db=db, state_key=phase_key)
        return {"ok": True, "event": event["event"], "note": "disabled"}
    person = event.get("user_name") or ""
    if step == "ask":
        await _set_dialog_phase(db, phase_key, "await_text")
        await db.commit()
        await _v2_reply(cfg, event, ask_text(person, voice), keyboard=send_keyboard("Отмена"), db=db, state_key=phase_key)
        return {"ok": True, "event": event["event"], "note": "ask"}
    if step == "cancel":
        await _set_dialog_phase(db, phase_key, "idle")
        await db.commit()
        await _v2_reply(cfg, event, cancel_text(person, voice), keyboard=send_keyboard(LEAVE), db=db, state_key=phase_key)
        return {"ok": True, "event": event["event"], "note": "cancel"}
    if step == "help":
        await _v2_reply(cfg, event, help_text(voice), keyboard=_menu(), db=db, state_key=phase_key)
        return {"ok": True, "event": event["event"], "note": "help"}
    if step == "status":
        last = await _last_bitrix_ticket(db, event)
        body = status_text(
            last.id if last is not None else None,
            last.title if last is not None else "",
            state=last.status if last is not None else "",
            voice=voice,
        )
        await _v2_reply(cfg, event, body, keyboard=_menu(), db=db, state_key=phase_key)
        return {"ok": True, "event": event["event"], "note": "status"}
    if step == "nudge":
        await _v2_reply(cfg, event, nudge_text(person, voice), keyboard=send_keyboard(LEAVE), db=db, state_key=phase_key)
        return {"ok": True, "event": event["event"], "note": "nudge"}
    if step == "greet":
        await _set_dialog_phase(db, phase_key, "idle")
        await db.commit()
        await _v2_reply(cfg, event, greeting_text(person, voice), keyboard=send_keyboard(LEAVE), db=db, state_key=phase_key)
        return {"ok": True, "event": event["event"], "note": "greet"}
    text = (event.get("text") or "").strip()
    row = await _open_bitrix_ticket(db, cfg, event, text)
    await _set_dialog_phase(db, phase_key, "idle")
    await db.commit()
    await db.refresh(row)
    await _v2_reply(cfg, event, accepted_text(row.id, text, name=person, voice=voice), keyboard=_menu(), db=db, state_key=phase_key)
    return {"ok": True, "request_id": row.id, "event": event["event"]}


def _sent_id(result: dict[str, Any]) -> str:
    for key in ("messageId", "id", "result"):
        value = result.get(key)
        text = str(value or "").strip()
        if text.isdigit():
            return text
    return ""


async def _remember_keyboard(db: AsyncSession, state_key: str, message_id: str, sig: str) -> None:
    key = state_key[:64]
    if not key:
        return
    row = await db.get(BitrixBotDialog, key)
    now = datetime.now(timezone.utc)
    if row is None:
        db.add(
            BitrixBotDialog(
                dialog_id=key,
                phase="idle",
                keyboard_message_id=message_id[:32],
                keyboard_sig=sig[:128],
                updated_at=now,
            )
        )
    else:
        row.keyboard_message_id = message_id[:32]
        row.keyboard_sig = sig[:128]
        row.updated_at = now
    await db.commit()


async def _clear_keyboard(cfg: Bitrix24Config, message_id: str) -> None:
    """Bitrix removes buttons only when keyboard is the string N, not an empty list."""
    if not message_id.isdigit():
        return
    try:
        await imbot_call(
            cfg.bot_webhook_url or "",
            "imbot.v2.Chat.Message.update",
            {
                "botId": int(cfg.bot_id or 0),
                "botToken": cfg.bot_token,
                "messageId": int(message_id),
                "fields": {"keyboard": "N"},
            },
        )
    except ImbotError as exc:
        log.warning("bitrix keyboard clear failed code=%s", exc.code)


async def _v2_reply(
    cfg: Bitrix24Config,
    event: dict[str, str],
    message: str,
    keyboard: list[dict[str, str]] | None = None,
    *,
    db: AsyncSession | None = None,
    state_key: str = "",
) -> bool:
    webhook = (cfg.bot_webhook_url or "").strip()
    token = (cfg.bot_token or "").strip()
    dialogs = dialog_candidates(event)
    if not webhook or not token or not cfg.bot_id or not dialogs:
        log.warning("bitrix reply skipped event=%s", event.get("event") or "")
        return False
    sig = keyboard_sig(keyboard)
    remembered = await db.get(BitrixBotDialog, state_key[:64]) if db is not None and state_key else None
    previous = (remembered.keyboard_sig or "") if remembered is not None else ""
    attach = attach_keyboard(previous, keyboard)
    if attach and remembered and (remembered.keyboard_message_id or "").strip():
        await _clear_keyboard(cfg, remembered.keyboard_message_id)
    fields: dict[str, Any] = {"message": message[:4000]}
    if attach:
        fields["keyboard"] = attach
    last_code = ""
    for dialog_id in dialogs:
        try:
            result = await imbot_call(
                webhook,
                "imbot.v2.Chat.Message.send",
                {
                    "botId": int(cfg.bot_id),
                    "botToken": token,
                    "dialogId": dialog_id,
                    "fields": fields,
                },
            )
            if attach and db is not None:
                await _remember_keyboard(db, state_key, _sent_id(result), sig)
            return True
        except ImbotError as exc:
            last_code = exc.code
            log.warning("bitrix reply failed dialog=%s code=%s", dialog_id, exc.code)
    if await _legacy_reply(cfg, dialogs[0], message, attach):
        if attach and db is not None:
            await _remember_keyboard(db, state_key, "", sig)
        return True
    log.warning("bitrix reply gave up code=%s", last_code or "unknown")
    return False


async def _legacy_reply(
    cfg: Bitrix24Config,
    dialog_id: str,
    message: str,
    keyboard: list[dict[str, str]] | None,
) -> bool:
    """imbot.message.add, the call the previous bot script used when v2 send is refused."""
    try:
        url = webhook_base(cfg.bot_webhook_url or "") + "imbot.message.add.json"
    except ImbotError:
        return False
    params: dict[str, str] = {
        "BOT_ID": str(cfg.bot_id or ""),
        "DIALOG_ID": dialog_id,
        "MESSAGE": message[:4000],
    }
    client_id = (settings.bitrix24_bot_client_id or "").strip()
    if client_id:
        params["CLIENT_ID"] = client_id
    if keyboard:
        params["KEYBOARD"] = json.dumps(
            {
                "BOT_ID": str(cfg.bot_id or ""),
                "BUTTONS": [
                    [
                        {
                            "TEXT": button["TEXT"],
                            "COMMAND": button["COMMAND"],
                            "DISPLAY": "BLOCK",
                        }
                        for button in keyboard
                    ]
                ],
            },
            ensure_ascii=False,
        )
    timeout = httpx.Timeout(20.0, connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, data=params)
        data = response.json()
    except (httpx.HTTPError, ValueError):
        log.warning("bitrix message.add unreachable")
        return False
    if not isinstance(data, dict) or data.get("error") or response.status_code >= 400:
        code = data.get("error") if isinstance(data, dict) else response.status_code
        log.warning("bitrix message.add code=%s", code)
        return False
    return True


@router.api_route("/handler", methods=["GET", "POST"])
async def handler(
    request: Request,
    db: AsyncSession = Depends(get_db),
    token: str | None = Query(default=None),
    x_handler_token: str | None = Header(default=None, alias="X-Handler-Token"),
    debug: int = Query(default=0),
):
    # NOTE: For the bot handler we do NOT gate behavior by Bitrix24Config.enabled.
    # That flag is meant for the "incoming webhook" integration page, while the bot
    # should still be able to reply and create requests when configured via .env.
    cfg = await _get_or_create_cfg(db)
    _verify_handler_token(token, x_handler_token, cfg.incoming_secret or "")

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
        payload = {}
    if not _first_str(payload.get("event"), payload.get("EVENT")):
        fallback = _payload_from_body(raw_body_text)
        if _first_str(fallback.get("event"), fallback.get("EVENT")):
            payload = fallback

    try:
        raw_payload_json = json.dumps(payload, ensure_ascii=False)
    except Exception:
        raw_payload_json = None
    _save_bot_inbox(
        {
            "received_at": datetime.now(timezone.utc).isoformat(),
            "content_type": ctype,
            "headers": {
                k: v
                for k, v in request.headers.items()
                if k.lower()
                not in {
                    "authorization",
                    "cookie",
                    "x-handler-token",
                    "x-forwarded-user",
                    "x-remote-user",
                }
            },
            "parsed": payload,
        },
        datetime.now(timezone.utc),
    )

    v2 = parse_v2_event(payload)
    if v2 is not None:
        return await _handle_v2(db, cfg, v2)

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
    title = bitrix_title(msg_text)
    requester_name: str | None = None
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

    row = ServiceRequest(
        title=title,
        description=msg_text.strip(),
        status="open",
        priority=(cfg.default_priority if cfg is not None and cfg.default_priority else "normal"),
        requester_name=requester_name,
        category=None,
        location=None,
        created_by_id=bot_user.id,
        opened_at=now,
        external_source="bitrix24",
        external_id=external_id,
        external_url=None,
        external_payload_json=raw_payload_json,
    )
    db.add(row)
    await db.flush()
    guessed = await _guess_category(db, row.title, row.description or "")
    if guessed:
        row.category = guessed
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

            voice = _voice(cfg)
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
                    "MESSAGE": accepted_text(row.id, msg_text, name=requester_name or "", voice=voice),
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

