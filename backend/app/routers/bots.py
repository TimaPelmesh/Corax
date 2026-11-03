"""Corax bot constructor: blueprints with dialogs, Bitrix register, AI binding stub."""

from __future__ import annotations

import json
import logging
import secrets
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_superuser
from app.database import get_db
from app.imbot_v2 import (
    ImbotError,
    appearance_fields,
    call,
    clean_code,
    clean_token,
    delivery_fields,
    profile_properties,
    public_card,
    webhook_base,
)
from app.models import Bitrix24Config, CoraxBot, User
from app.schemas import CoraxBotCreate, CoraxBotOut, CoraxBotUpdate
from app.routers.bitrix24_bot_handler import _get_or_create_cfg

router = APIRouter(prefix="/settings/bots", tags=["bots"])
log = logging.getLogger("corax.bots")

_CHANNELS = frozenset({"bitrix24", "local"})
_STATUSES = frozenset({"draft", "registered", "paused"})

DEFAULT_DIALOGS: dict[str, Any] = {
    "entry": "start",
    "nodes": {
        "start": {
            "type": "message",
            "text": "Здравствуйте! Чем могу помочь?",
            "buttons": [{"label": "Задать вопрос", "next": "ask"}],
        },
        "ask": {
            "type": "input",
            "prompt": "Напишите ваш вопрос одним сообщением.",
            "next": "ai_reply",
        },
        "ai_reply": {"type": "ai", "fallback": "done"},
        "done": {
            "type": "message",
            "text": "Спасибо! Если понадобится ещё помощь — напишите снова.",
        },
    },
}


def _load_json(raw: str | None, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    if not (raw or "").strip():
        return dict(fallback or {})
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return dict(fallback or {})
    return data if isinstance(data, dict) else dict(fallback or {})


def _dump_json(data: dict[str, Any] | None) -> str:
    return json.dumps(data or {}, ensure_ascii=False)


def _out(row: CoraxBot) -> CoraxBotOut:
    return CoraxBotOut(
        id=row.id,
        name=row.name or "",
        purpose=row.purpose or "",
        channel=row.channel or "bitrix24",
        status=row.status or "draft",
        code=row.code or "",
        external_bot_id=row.external_bot_id,
        token_set=bool((row.bot_token or "").strip()),
        dialogs=_load_json(row.dialogs_json, DEFAULT_DIALOGS),
        ai_enabled=bool(row.ai_enabled),
        ai_model=row.ai_model or "",
        ai_system_prompt=row.ai_system_prompt or "",
        config=_load_json(row.config_json, {}),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _panel_origin(request: Request) -> str:
    origin = (request.headers.get("origin") or "").strip()
    if origin:
        return origin.rstrip("/")
    return ""


def _handler_url(cfg: Bitrix24Config, origin: str) -> str:
    secret = (cfg.incoming_secret or "").strip()
    public = origin.rstrip("/")
    if not public or not secret:
        return ""
    return f"{public}/handler?token={quote(secret)}"


def _raise_imbot(exc: ImbotError) -> None:
    raise HTTPException(status_code=400, detail=f"{exc.code}: {exc.description}" if exc.description else exc.code)


async def _get_bot(db: AsyncSession, bot_id: int) -> CoraxBot:
    row = await db.get(CoraxBot, bot_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Бот не найден")
    return row


@router.get("", response_model=list[CoraxBotOut])
async def list_bots(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.scalars(select(CoraxBot).order_by(CoraxBot.id.desc()))).all()
    return [_out(row) for row in rows]


@router.post("", response_model=CoraxBotOut)
async def create_bot(
    body: CoraxBotCreate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    channel = (body.channel or "bitrix24").strip().lower()
    if channel not in _CHANNELS:
        raise HTTPException(status_code=400, detail="Канал: bitrix24 или local")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Укажите имя бота")
    row = CoraxBot(
        name=name[:128],
        purpose=(body.purpose or "").strip()[:512],
        channel=channel,
        status="draft",
        code="corax_" + secrets.token_hex(4),
        bot_token=secrets.token_hex(16),
        dialogs_json=_dump_json(DEFAULT_DIALOGS),
        config_json=_dump_json({"color": "GREEN", "bot_type": "bot"}),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.get("/{bot_id}", response_model=CoraxBotOut)
async def get_bot(
    bot_id: int,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    return _out(await _get_bot(db, bot_id))


@router.patch("/{bot_id}", response_model=CoraxBotOut)
async def update_bot(
    bot_id: int,
    body: CoraxBotUpdate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_bot(db, bot_id)
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        name = str(data["name"]).strip()
        if not name:
            raise HTTPException(status_code=400, detail="Укажите имя бота")
        row.name = name[:128]
    if "purpose" in data and data["purpose"] is not None:
        row.purpose = str(data["purpose"]).strip()[:512]
    if "channel" in data and data["channel"] is not None:
        channel = str(data["channel"]).strip().lower()
        if channel not in _CHANNELS:
            raise HTTPException(status_code=400, detail="Канал: bitrix24 или local")
        row.channel = channel
    if "status" in data and data["status"] is not None:
        status = str(data["status"]).strip().lower()
        if status not in _STATUSES:
            raise HTTPException(status_code=400, detail="Статус: draft, registered или paused")
        row.status = status
    if "dialogs" in data and data["dialogs"] is not None:
        if not isinstance(data["dialogs"], dict):
            raise HTTPException(status_code=400, detail="dialogs должен быть объектом")
        row.dialogs_json = _dump_json(data["dialogs"])
    if "ai_enabled" in data and data["ai_enabled"] is not None:
        row.ai_enabled = bool(data["ai_enabled"])
    if "ai_model" in data and data["ai_model"] is not None:
        row.ai_model = str(data["ai_model"]).strip()[:128]
    if "ai_system_prompt" in data and data["ai_system_prompt"] is not None:
        row.ai_system_prompt = str(data["ai_system_prompt"])[:8000]
    if "config" in data and data["config"] is not None:
        if not isinstance(data["config"], dict):
            raise HTTPException(status_code=400, detail="config должен быть объектом")
        row.config_json = _dump_json(data["config"])
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.delete("/{bot_id}")
async def delete_bot(
    bot_id: int,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_bot(db, bot_id)
    await db.delete(row)
    await db.commit()
    return {"ok": True}


@router.post("/{bot_id}/register", response_model=CoraxBotOut)
async def register_bot(
    bot_id: int,
    request: Request,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Register this blueprint in Bitrix24 without touching the ticket-bot singleton id."""
    row = await _get_bot(db, bot_id)
    if (row.channel or "") != "bitrix24":
        raise HTTPException(status_code=400, detail="Регистрация доступна только для канала bitrix24")
    cfg = await _get_or_create_cfg(db)
    if not (cfg.bot_webhook_url or "").strip():
        raise HTTPException(
            status_code=400,
            detail="Сначала укажите входящий вебхук Bitrix24 в настройках Bitrix",
        )
    if not (row.bot_token or "").strip():
        row.bot_token = secrets.token_hex(16)
    if not (row.code or "").strip():
        row.code = "corax_" + secrets.token_hex(4)
    try:
        token = clean_token(row.bot_token, required=True)
        code = clean_code(row.code)
        webhook = webhook_base(cfg.bot_webhook_url or "")
        config = _load_json(row.config_json, {})
        properties = profile_properties(
            {
                "name": row.name or "Corax bot",
                "last_name": str(config.get("last_name") or ""),
                "position": (row.purpose or str(config.get("position") or "Corax") or "Corax")[:128],
                "color": str(config.get("color") or "GREEN"),
                "gender": str(config.get("gender") or ""),
            }
        )
        if "name" not in properties:
            properties["name"] = row.name or "Corax bot"
        mode = str(config.get("event_mode") or cfg.bot_event_mode or "fetch")
        handler = _handler_url(cfg, _panel_origin(request)) if mode == "webhook" else ""
        fields: dict[str, Any] = {
            "properties": properties,
            "type": str(config.get("bot_type") or "bot"),
            **appearance_fields(
                {
                    "hidden": config.get("hidden"),
                    "reactions": config.get("reactions", True),
                    "openline": config.get("openline", False),
                    "background_id": config.get("background_id"),
                }
            ),
            **delivery_fields(mode, handler or None),
        }
        if row.external_bot_id:
            result = await call(
                webhook,
                "imbot.v2.Bot.update",
                {"botId": int(row.external_bot_id), "botToken": token, "fields": fields},
            )
        else:
            fields["code"] = code
            fields["botToken"] = token
            result = await call(webhook, "imbot.v2.Bot.register", {"fields": fields})
            card = public_card(result)
            if card.get("bot_id"):
                row.external_bot_id = int(card["bot_id"])
        card = public_card(result)
        if card.get("bot_id") and not row.external_bot_id:
            row.external_bot_id = int(card["bot_id"])
        row.status = "registered"
    except ImbotError as exc:
        _raise_imbot(exc)
    await db.commit()
    await db.refresh(row)
    return _out(row)


@router.post("/{bot_id}/unregister", response_model=CoraxBotOut)
async def unregister_bot(
    bot_id: int,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_bot(db, bot_id)
    cfg = await _get_or_create_cfg(db)
    if row.external_bot_id and (cfg.bot_webhook_url or "").strip() and (row.bot_token or "").strip():
        try:
            await call(
                cfg.bot_webhook_url or "",
                "imbot.v2.Bot.unregister",
                {
                    "botId": int(row.external_bot_id),
                    "botToken": clean_token(row.bot_token or "", required=True),
                },
            )
        except ImbotError as exc:
            log.warning("bitrix unregister failed bot=%s code=%s", bot_id, exc.code)
            _raise_imbot(exc)
    row.external_bot_id = None
    row.status = "draft"
    await db.commit()
    await db.refresh(row)
    return _out(row)
