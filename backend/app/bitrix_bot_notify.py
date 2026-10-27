"""Tell the Bitrix chat when a ticket that came from the bot is closed."""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.bot_intake import closed_text
from app.models import Bitrix24Config, ServiceRequest

log = logging.getLogger("corax.bitrix.bot")


def _payload(row: ServiceRequest) -> dict[str, Any]:
    try:
        loaded = json.loads(row.external_payload_json or "{}")
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _store(row: ServiceRequest, payload: dict[str, Any]) -> None:
    row.external_payload_json = json.dumps(payload, ensure_ascii=False)


def clear_close_notice(row: ServiceRequest) -> None:
    """A reopened ticket can be announced again the next time it is closed."""
    payload = _payload(row)
    if not payload.get("close_notified"):
        return
    payload.pop("close_notified", None)
    _store(row, payload)


async def notify_ticket_closed(db: AsyncSession, row: ServiceRequest) -> None:
    if (row.external_source or "") != "bitrix24":
        return
    payload = _payload(row)
    if payload.get("close_notified"):
        return
    cfg = await db.get(Bitrix24Config, 1)
    if cfg is None or not cfg.bot_id or not (cfg.bot_webhook_url or "").strip() or not (cfg.bot_token or "").strip():
        return
    if cfg.bot_close_notice is False:
        return
    user_id = str(payload.get("user_id") or "").strip()
    dialog_id = str(payload.get("dialog_id") or user_id).strip()
    if not dialog_id:
        return
    state_key = f"user:{user_id}" if user_id else dialog_id
    from app.routers.bitrix24_bot_handler import _menu, _v2_reply, _voice

    voice = _voice(cfg)
    text = closed_text(
        row.id,
        name=row.requester_name or "",
        status=row.status or "",
        voice=voice,
    )
    try:
        sent = await _v2_reply(
            cfg,
            {
                "event": "close",
                "dialog_id": dialog_id,
                "user_id": str(payload.get("user_id") or ""),
                "chat_id": "",
            },
            text,
            keyboard=_menu(),
            db=db,
            state_key=state_key,
        )
    except Exception:
        log.warning("bitrix close notice failed request_id=%s", row.id)
        return
    if not sent:
        return
    payload["close_notified"] = True
    _store(row, payload)
    log.info("bitrix close notice request_id=%s", row.id)
