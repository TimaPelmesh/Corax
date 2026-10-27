"""Administer one imbot.v2 chatbot from the Bitrix24 settings page."""

from __future__ import annotations

import logging
import secrets
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_superuser
from app.bot_intake import drop_phrases, dump_scripts, normalize_phrases, parse_scripts, publish_phrases
from app.database import get_db
from app.imbot_v2 import (
    BACKGROUNDS,
    BOT_TYPES,
    ImbotError,
    appearance_fields,
    call,
    clean_code,
    clean_email,
    clean_event_mode,
    clean_token,
    legacy_email_body,
    delivery_fields,
    profile_properties,
    profile_update_fields,
    public_bots,
    public_card,
    webhook_base,
    webhook_host,
)
from app.models import Bitrix24Config, User
from app.routers.bitrix24_bot_handler import _get_or_create_cfg, publish_menu, show_saved_phrases

router = APIRouter(prefix="/settings/bitrix24/bot", tags=["bitrix24-imbot"])
log = logging.getLogger("corax.bitrix.bot")


class BotOut(BaseModel):
    webhook_set: bool
    webhook_host: str
    token_set: bool
    bot_id: int | None = None
    code: str
    bot_type: str
    name: str
    last_name: str
    position: str
    email: str = ""
    color: str
    gender: str
    public_url: str
    handler_url: str
    event_mode: str = "fetch"
    background_id: str = ""
    hidden: bool = False
    reactions: bool = True
    openline: bool = False
    bot_enabled: bool = False
    greet_name: bool = True
    greet_daypart: bool = True
    greeting_note: str = ""
    close_notice: bool = True
    scripts: dict[str, dict[str, Any]] = Field(default_factory=dict)


class BotSave(BaseModel):
    webhook_url: str | None = Field(default=None, max_length=2000)
    bot_token: str | None = Field(default=None, max_length=40)
    bot_id: int | None = None
    code: str | None = Field(default=None, max_length=64)
    bot_type: str | None = Field(default=None, max_length=16)
    name: str | None = Field(default=None, max_length=128)
    last_name: str | None = Field(default=None, max_length=128)
    position: str | None = Field(default=None, max_length=128)
    email: str | None = Field(default=None, max_length=255)
    color: str | None = Field(default=None, max_length=32)
    gender: str | None = Field(default=None, max_length=1)
    greet_name: bool | None = None
    greet_daypart: bool | None = None
    greeting_note: str | None = Field(default=None, max_length=400)
    close_notice: bool | None = None
    event_mode: str | None = Field(default=None, max_length=16)
    background_id: str | None = Field(default=None, max_length=32)
    hidden: bool | None = None
    reactions: bool | None = None
    openline: bool | None = None


class BotEnable(BaseModel):
    enabled: bool


class BotProfile(BaseModel):
    name: str = Field(default="", max_length=128)
    last_name: str = Field(default="", max_length=128)
    position: str = Field(default="", max_length=128)
    email: str = Field(default="", max_length=255)
    color: str = Field(default="", max_length=32)
    gender: str = Field(default="", max_length=1)
    avatar_base64: str | None = Field(default=None, max_length=2_000_000)
    hidden: bool | None = None
    background_id: str | None = Field(default=None, max_length=32)
    bot_type: str | None = Field(default=None, max_length=16)
    event_mode: str | None = Field(default=None, max_length=16)
    reactions: bool | None = None
    openline: bool | None = None


class BotMode(BaseModel):
    event_mode: str = Field(max_length=16)


class BotDrop(BaseModel):
    bot_id: int


class BotPhrasesIn(BaseModel):
    bot_id: int
    apply: bool = False
    greet_daypart: bool | None = None
    close_notice: bool | None = None
    greeting_note: str | None = Field(default=None, max_length=400)
    greet_body: str | None = Field(default=None, max_length=800)
    greet_tail: str | None = Field(default=None, max_length=800)
    ask: str | None = Field(default=None, max_length=800)
    cancel: str | None = Field(default=None, max_length=800)
    accepted: str | None = Field(default=None, max_length=800)
    closed: str | None = Field(default=None, max_length=800)
    help: str | None = Field(default=None, max_length=800)
    nudge: str | None = Field(default=None, max_length=800)
    off: str | None = Field(default=None, max_length=800)
    no_ticket: str | None = Field(default=None, max_length=800)
    status: str | None = Field(default=None, max_length=800)


def _stored_mode(row: Bitrix24Config) -> str:
    try:
        return clean_event_mode(row.bot_event_mode or "fetch")
    except ImbotError:
        return "fetch"


def _out(row: Bitrix24Config, origin: str = "") -> BotOut:
    secret = (row.incoming_secret or "").strip()
    public = (row.bot_public_url or "").strip().rstrip("/") or (origin or "").rstrip("/")
    handler = f"{public}/handler?token={quote(secret)}" if public and secret else ""
    return BotOut(
        webhook_set=bool((row.bot_webhook_url or "").strip()),
        webhook_host=webhook_host(row.bot_webhook_url or ""),
        token_set=bool((row.bot_token or "").strip()),
        bot_id=row.bot_id,
        code=row.bot_code or "",
        bot_type=row.bot_type or "bot",
        name=row.bot_name or "",
        last_name=row.bot_last_name or "",
        position=row.bot_position or "",
        email=row.bot_email or "",
        color=row.bot_color or "GREEN",
        gender=row.bot_gender or "",
        public_url=public,
        handler_url=handler,
        event_mode=_stored_mode(row),
        background_id=(row.bot_background or "").strip(),
        hidden=bool(row.bot_hidden),
        reactions=True if row.bot_reactions is None else bool(row.bot_reactions),
        openline=bool(row.bot_openline),
        bot_enabled=bool(row.bot_id) and not bool(row.bot_paused),
        greet_name=row.bot_greet_name is not False,
        greet_daypart=row.bot_greet_daypart is not False,
        greeting_note=(row.bot_greeting_note or "")[:400],
        close_notice=row.bot_close_notice is not False,
        scripts=_scripts_out(row),
    )


def _legacy_phrases(row: Bitrix24Config) -> dict[str, Any]:
    return normalize_phrases(
        {
            "greet_daypart": row.bot_greet_daypart is not False,
            "close_notice": row.bot_close_notice is not False,
            "greeting_note": row.bot_greeting_note or "",
        }
    )


def _scripts_out(row: Bitrix24Config) -> dict[str, dict[str, Any]]:
    scripts = parse_scripts(row.bot_scripts_json)
    if row.bot_id and str(row.bot_id) not in scripts:
        legacy = _legacy_phrases(row)
        if legacy:
            scripts[str(row.bot_id)] = legacy
    return scripts


def _mirror_phrases(row: Bitrix24Config, phrases: dict[str, Any]) -> None:
    by_time = phrases.get("greet_daypart", True) is not False
    row.bot_greet_daypart = by_time
    row.bot_greet_name = by_time
    row.bot_greeting_note = str(phrases.get("greeting_note") or "")[:400]
    row.bot_close_notice = phrases.get("close_notice", True) is not False


def _stash_active_phrases(row: Bitrix24Config) -> None:
    """Keep the current bot's lines under its id before another bot becomes active."""
    if not row.bot_id:
        return
    scripts = parse_scripts(row.bot_scripts_json)
    key = str(row.bot_id)
    if key not in scripts:
        legacy = _legacy_phrases(row)
        if legacy:
            scripts[key] = legacy
    row.bot_scripts_json = dump_scripts(scripts)


def _fold_columns_into_script(row: Bitrix24Config) -> None:
    """Column edits stay visible: the per-bot script is what the chat actually reads."""
    if not row.bot_id:
        return
    scripts = parse_scripts(row.bot_scripts_json)
    key = str(row.bot_id)
    merged = dict(scripts.get(key, {}))
    legacy = _legacy_phrases(row)
    for flag in ("greet_daypart", "close_notice", "greeting_note"):
        if flag in legacy:
            merged[flag] = legacy[flag]
        else:
            merged.pop(flag, None)
    clean = normalize_phrases(merged)
    if clean:
        scripts[key] = clean
    else:
        scripts.pop(key, None)
    row.bot_scripts_json = dump_scripts(scripts)


def _apply_save(row: Bitrix24Config, body: BotSave) -> None:
    data = body.model_dump(exclude_unset=True)
    if "webhook_url" in data and (data["webhook_url"] or "").strip():
        row.bot_webhook_url = webhook_base(data["webhook_url"])
    if "bot_token" in data and (data["bot_token"] or "").strip():
        row.bot_token = clean_token(data["bot_token"], required=True)
    if "bot_id" in data:
        new_id = int(data["bot_id"]) if data["bot_id"] else None
        if new_id != row.bot_id:
            _stash_active_phrases(row)
            scripts = parse_scripts(row.bot_scripts_json)
            _mirror_phrases(row, scripts.get(str(new_id), {}) if new_id else {})
        row.bot_id = new_id
    if "code" in data and (data["code"] or "").strip():
        row.bot_code = clean_code(data["code"])
    if "bot_type" in data and (data["bot_type"] or "").strip():
        kind = data["bot_type"].strip()
        if kind not in BOT_TYPES:
            raise ImbotError("BOT_INVALID_TYPE", "Тип: bot, supervisor или personal")
        row.bot_type = kind
    for src, dest in (
        ("name", "bot_name"),
        ("last_name", "bot_last_name"),
        ("position", "bot_position"),
        ("color", "bot_color"),
        ("gender", "bot_gender"),
    ):
        if src in data and data[src] is not None:
            setattr(row, dest, str(data[src]).strip())
    if "email" in data and data["email"] is not None:
        row.bot_email = clean_email(str(data["email"]))
    if "greet_name" in data and data["greet_name"] is not None:
        row.bot_greet_name = bool(data["greet_name"])
    if "greet_daypart" in data and data["greet_daypart"] is not None:
        row.bot_greet_daypart = bool(data["greet_daypart"])
    if "greeting_note" in data and data["greeting_note"] is not None:
        row.bot_greeting_note = str(data["greeting_note"]).strip()[:400]
    if "close_notice" in data and data["close_notice"] is not None:
        row.bot_close_notice = bool(data["close_notice"])
    if any(key in data for key in ("greet_daypart", "greeting_note", "close_notice")):
        _fold_columns_into_script(row)
    if "event_mode" in data and data["event_mode"] is not None:
        row.bot_event_mode = clean_event_mode(str(data["event_mode"]))
    if "background_id" in data and data["background_id"] is not None:
        text = str(data["background_id"]).strip()
        if not text or text == "default":
            row.bot_background = ""
        elif text not in BACKGROUNDS:
            raise ImbotError("BOT_BACKGROUND_INVALID", "Такого фона чата нет")
        else:
            row.bot_background = text
    if "hidden" in data and data["hidden"] is not None:
        row.bot_hidden = bool(data["hidden"])
    if "reactions" in data and data["reactions"] is not None:
        row.bot_reactions = bool(data["reactions"])
    if "openline" in data and data["openline"] is not None:
        row.bot_openline = bool(data["openline"])


def _panel_origin(request: Request) -> str:
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    scheme = "https" if request.url.scheme == "https" or forwarded == "https" else "http"
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if not host:
        host = request.url.netloc
    return f"{scheme}://{host}".rstrip("/")


def _handler_url(row: Bitrix24Config, origin: str) -> str:
    secret = (row.incoming_secret or "").strip()
    if not secret:
        secret = secrets.token_urlsafe(24)
        row.incoming_secret = secret
    public = origin.rstrip("/")
    row.bot_public_url = public
    return f"{public}/handler?token={quote(secret)}"


def _raise(exc: ImbotError) -> None:
    raise HTTPException(status_code=400, detail=exc.description or exc.code) from exc


def _look(row: Bitrix24Config) -> dict[str, Any]:
    return {
        "hidden": bool(row.bot_hidden),
        "reactions": True if row.bot_reactions is None else bool(row.bot_reactions),
        "openline": bool(row.bot_openline),
        "background_id": (row.bot_background or "").strip() or "default",
    }


def _delivery(row: Bitrix24Config, origin: str) -> dict[str, Any]:
    mode = clean_event_mode(row.bot_event_mode or "fetch")
    row.bot_event_mode = mode
    handler = _handler_url(row, origin) if mode == "webhook" else ""
    return delivery_fields(mode, handler)


@router.get("", response_model=BotOut)
async def get_bot_settings(
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    return _out(await _get_or_create_cfg(db), _panel_origin(request))


@router.put("", response_model=BotOut)
async def save_bot_settings(
    body: BotSave,
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_cfg(db)
    try:
        _apply_save(row, body)
    except ImbotError as exc:
        _raise(exc)
    await db.commit()
    await db.refresh(row)
    return _out(row, _panel_origin(request))


@router.get("/bots")
async def list_known_bots(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Bots of this webhook via imbot.v2.Bot.list. Empty until a token is stored."""
    row = await _get_or_create_cfg(db)
    if not (row.bot_webhook_url or "").strip() or not (row.bot_token or "").strip():
        return {"items": []}
    token = clean_token(row.bot_token or "", required=True)
    items: list[dict[str, Any]] = []
    offset = 0
    try:
        for _page in range(10):
            result = await call(
                row.bot_webhook_url or "",
                "imbot.v2.Bot.list",
                {"botToken": token, "limit": 50, "offset": offset},
            )
            items.extend(public_bots(result))
            if not result.get("hasNextPage"):
                break
            offset += 50
    except ImbotError as exc:
        _raise(exc)
    return {"items": items}


@router.post("/register", response_model=BotOut)
async def register_bot(
    body: BotSave,
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Create a bot, or point an existing bot id at this panel. Empty token and code are generated."""
    row = await _get_or_create_cfg(db)
    try:
        _apply_save(row, body)
        if not (row.bot_token or "").strip():
            row.bot_token = secrets.token_hex(16)
        if not (row.bot_code or "").strip():
            row.bot_code = "corax_" + secrets.token_hex(4)
        clean_token(row.bot_token, required=True)
        clean_code(row.bot_code)
        webhook = webhook_base(row.bot_webhook_url or "")
        properties = profile_properties(
            {
                "name": row.bot_name or "Бот заявок",
                "last_name": row.bot_last_name,
                "position": row.bot_position or "Приём заявок",
                "color": row.bot_color or "GREEN",
                "gender": row.bot_gender,
            }
        )
        if "name" not in properties:
            properties["name"] = "Бот заявок"
        fields: dict[str, Any] = {
            "properties": properties,
            "type": row.bot_type or "bot",
            **appearance_fields(_look(row)),
            **_delivery(row, _panel_origin(request)),
        }
        if row.bot_id:
            result = await call(
                webhook,
                "imbot.v2.Bot.update",
                {"botId": int(row.bot_id), "botToken": row.bot_token, "fields": fields},
            )
        else:
            fields["code"] = row.bot_code
            fields["botToken"] = row.bot_token
            result = await call(webhook, "imbot.v2.Bot.register", {"fields": fields})
            card = public_card(result)
            if card.get("bot_id"):
                row.bot_id = int(card["bot_id"])
        card = public_card(result)
        _remember(row, card)
        await _push_email(row)
        row.bot_enabled = True
        row.bot_paused = False
        await publish_menu(row)
    except ImbotError as exc:
        _raise(exc)
    await db.commit()
    await db.refresh(row)
    return _out(row, _panel_origin(request))


@router.post("/enable", response_model=BotOut)
async def set_bot_enabled(
    body: BotEnable,
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Turn ticket intake on or off. Enabling keeps the saved fetch or webhook mode."""
    row = await _get_or_create_cfg(db)
    if body.enabled:
        if not row.bot_id or not (row.bot_webhook_url or "").strip() or not (row.bot_token or "").strip():
            _raise(ImbotError("BOT_NOT_READY", "Сначала укажите вебхук и создайте или подключите бота"))
        try:
            await call(
                row.bot_webhook_url or "",
                "imbot.v2.Bot.update",
                {
                    "botId": int(row.bot_id),
                    "botToken": clean_token(row.bot_token or "", required=True),
                    "fields": _delivery(row, _panel_origin(request)),
                },
            )
        except ImbotError as exc:
            _raise(exc)
        await publish_menu(row)
    row.bot_enabled = bool(body.enabled)
    row.bot_paused = not body.enabled
    await db.commit()
    await db.refresh(row)
    return _out(row, _panel_origin(request))


@router.post("/read", response_model=BotOut)
async def read_bot(
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_cfg(db)
    if not row.bot_id:
        raise HTTPException(status_code=400, detail="Сначала укажите ID бота или создайте его")
    try:
        result = await call(
            row.bot_webhook_url or "",
            "imbot.v2.Bot.get",
            {"botId": int(row.bot_id), "botToken": clean_token(row.bot_token or "", required=True)},
        )
        card = public_card(result)
        _remember(row, card)
    except ImbotError as exc:
        _raise(exc)
    await db.commit()
    await db.refresh(row)
    return _out(row, _panel_origin(request))


@router.post("/mode", response_model=BotOut)
async def set_bot_mode(
    body: BotMode,
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Remember fetch or webhook and, when a bot exists, write that mode to Bitrix24."""
    row = await _get_or_create_cfg(db)
    try:
        row.bot_event_mode = clean_event_mode(body.event_mode)
        if row.bot_id and (row.bot_webhook_url or "").strip() and (row.bot_token or "").strip():
            await call(
                row.bot_webhook_url or "",
                "imbot.v2.Bot.update",
                {
                    "botId": int(row.bot_id),
                    "botToken": clean_token(row.bot_token or "", required=True),
                    "fields": _delivery(row, _panel_origin(request)),
                },
            )
        await publish_menu(row)
    except ImbotError as exc:
        _raise(exc)
    await db.commit()
    await db.refresh(row)
    return _out(row, _panel_origin(request))


@router.put("/phrases", response_model=BotOut)
async def save_bot_phrases(
    body: BotPhrasesIn,
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Store one bot's replies. Only the bot Corax is bound to says them in chat.

    apply=true restarts the queue reader so the next chat message is guaranteed
    to use this text, even if the reader still held the previous row.
    """
    if body.bot_id <= 0:
        raise HTTPException(status_code=400, detail="Укажите бота")
    row = await _get_or_create_cfg(db)
    scripts = parse_scripts(row.bot_scripts_json)
    clean = normalize_phrases(body.model_dump(exclude={"bot_id", "apply"}, exclude_none=True))
    key = str(int(body.bot_id))
    if clean:
        scripts[key] = clean
    else:
        scripts.pop(key, None)
    row.bot_scripts_json = dump_scripts(scripts)
    if row.bot_id == int(body.bot_id):
        _mirror_phrases(row, clean)
    await db.commit()
    await db.refresh(row)
    publish_phrases(int(body.bot_id), scripts.get(key, {}))
    if body.apply and row.bot_id == int(body.bot_id):
        await show_saved_phrases(db, row)
        from app.bitrix_bot_poll import reload_worker

        await reload_worker()
    return _out(row, _panel_origin(request))


@router.post("/unregister", response_model=BotOut)
async def unregister_bot(
    body: BotDrop,
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Delete one bot of this webhook. Only the bound bot is cleared locally."""
    row = await _get_or_create_cfg(db)
    if not (row.bot_webhook_url or "").strip() or not (row.bot_token or "").strip():
        _raise(ImbotError("BOT_NOT_READY", "Сначала сохраните вебхук и токен бота"))
    try:
        await call(
            row.bot_webhook_url or "",
            "imbot.v2.Bot.unregister",
            {"botId": int(body.bot_id), "botToken": clean_token(row.bot_token or "", required=True)},
        )
    except ImbotError as exc:
        _raise(exc)
    scripts = parse_scripts(row.bot_scripts_json)
    scripts.pop(str(int(body.bot_id)), None)
    drop_phrases(int(body.bot_id))
    row.bot_scripts_json = dump_scripts(scripts)
    if row.bot_id == int(body.bot_id):
        row.bot_id = None
        row.bot_enabled = False
        row.bot_paused = True
        _mirror_phrases(row, {})
    await db.commit()
    await db.refresh(row)
    return _out(row, _panel_origin(request))


async def _push_email(row: Bitrix24Config) -> None:
    """Write the mailbox through imbot.update. v2.Bot.update has no email field."""
    email = (row.bot_email or "").strip()
    if not email or not row.bot_id or not (row.bot_webhook_url or "").strip():
        return
    try:
        await call(
            row.bot_webhook_url or "",
            "imbot.update",
            legacy_email_body(int(row.bot_id), email),
        )
    except ImbotError as exc:
        if exc.code == "ERROR_METHOD_NOT_FOUND":
            log.warning("bitrix bot email stays in Corax, portal has no imbot.update")
            return
        raise


def _store_profile(row: Bitrix24Config, body: BotProfile) -> None:
    """Keep the typed profile on the Corax row. A later Bitrix echo must not replace it."""
    if body.bot_type and body.bot_type.strip() in BOT_TYPES:
        row.bot_type = body.bot_type.strip()
    if body.event_mode:
        row.bot_event_mode = clean_event_mode(body.event_mode)
    if body.background_id is not None:
        _apply_save(row, BotSave(background_id=body.background_id))
    if body.hidden is not None:
        row.bot_hidden = bool(body.hidden)
    if body.reactions is not None:
        row.bot_reactions = bool(body.reactions)
    if body.openline is not None:
        row.bot_openline = bool(body.openline)
    if body.gender.strip().upper() in {"M", "F"}:
        row.bot_gender = body.gender.strip().upper()
    elif body.gender == "":
        row.bot_gender = ""
    row.bot_name = body.name.strip()[:128]
    row.bot_last_name = body.last_name.strip()[:128]
    row.bot_position = body.position.strip()[:128]
    row.bot_email = clean_email(body.email)
    if body.color.strip():
        row.bot_color = body.color.strip().upper()


@router.post("/profile", response_model=BotOut)
async def update_profile(
    body: BotProfile,
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Write the profile in Corax, then push the name to Bitrix.

    The portal call used to include event mode and the bot type. Bitrix
    rejects the whole update when one of those is wrong, and the new name
    was never stored. The name is committed even if Bitrix refuses it.
    """
    row = await _get_or_create_cfg(db)
    if not row.bot_id:
        raise HTTPException(status_code=400, detail="Сначала укажите ID бота или создайте его")
    try:
        clean_email(body.email)
        fields = profile_update_fields(body.model_dump())
        _store_profile(row, body)
        await call(
            row.bot_webhook_url or "",
            "imbot.v2.Bot.update",
            {
                "botId": int(row.bot_id),
                "botToken": clean_token(row.bot_token or "", required=True),
                "fields": fields,
            },
        )
        await _push_email(row)
    except ImbotError as exc:
        await db.commit()
        _raise(exc)
    await publish_menu(row)
    await db.commit()
    await db.refresh(row)
    return _out(row, _panel_origin(request))


def _remember(row: Bitrix24Config, card: dict[str, Any]) -> None:
    if card.get("code"):
        row.bot_code = str(card["code"])[:64]
    if card.get("bot_type"):
        row.bot_type = str(card["bot_type"])[:16]
    if card.get("name"):
        row.bot_name = str(card["name"])[:128]
    if card.get("last_name"):
        row.bot_last_name = str(card["last_name"])[:128]
    if card.get("position"):
        row.bot_position = str(card["position"])[:128]
    if card.get("email"):
        row.bot_email = str(card["email"])[:255]
    if card.get("gender") in {"M", "F"}:
        row.bot_gender = str(card["gender"])
    if card.get("event_mode") in {"fetch", "webhook"}:
        row.bot_event_mode = str(card["event_mode"])
    if "background_id" in card:
        row.bot_background = str(card.get("background_id") or "")[:32]
    if "hidden" in card:
        row.bot_hidden = bool(card.get("hidden"))
    if card.get("reactions") is not None:
        row.bot_reactions = bool(card["reactions"])
    if card.get("openline") is not None:
        row.bot_openline = bool(card["openline"])
