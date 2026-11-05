"""Tell the Bitrix chat when a ticket that came from the bot is closed."""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
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


async def plan_close_notice(db: AsyncSession, row: ServiceRequest) -> dict[str, Any] | None:
    """Read what the close message needs. Does not call Bitrix and does not commit."""
    if (row.external_source or "") != "bitrix24":
        return None
    payload = _payload(row)
    if payload.get("close_notified"):
        return None
    cfg = await db.get(Bitrix24Config, 1)
    if cfg is None or not cfg.bot_id or not (cfg.bot_webhook_url or "").strip() or not (cfg.bot_token or "").strip():
        return None
    if cfg.bot_close_notice is False:
        return None
    user_id = str(payload.get("user_id") or "").strip()
    dialog_id = str(payload.get("dialog_id") or user_id).strip()
    if not dialog_id:
        return None
    from app.routers.bitrix24_bot_handler import _voice

    voice = _voice(cfg)
    return {
        "request_id": row.id,
        "state_key": f"user:{user_id}" if user_id else dialog_id,
        "text": closed_text(
            row.id,
            name=row.requester_name or "",
            status=row.status or "",
            voice=voice,
        ),
        "event": {
            "event": "close",
            "dialog_id": dialog_id,
            "user_id": user_id,
            "chat_id": "",
        },
        "cfg": SimpleNamespace(
            bot_webhook_url=cfg.bot_webhook_url,
            bot_token=cfg.bot_token,
            bot_id=cfg.bot_id,
        ),
    }


async def deliver_close_notice(plan: dict[str, Any]) -> None:
    """Send the chat message with no panel connection checked out."""
    from app.database import AsyncSessionLocal
    from app.routers.bitrix24_bot_handler import _menu, _v2_reply

    request_id = int(plan["request_id"])
    try:
        sent = await _v2_reply(
            plan["cfg"],
            plan["event"],
            plan["text"],
            keyboard=_menu(),
            db=None,
            state_key=str(plan["state_key"]),
        )
    except Exception:
        log.warning("bitrix close notice failed request_id=%s", request_id)
        return
    if not sent:
        return
    async with AsyncSessionLocal() as db:
        fresh = await db.get(ServiceRequest, request_id)
        if fresh is None:
            return
        payload = _payload(fresh)
        payload["close_notified"] = True
        _store(fresh, payload)
        await db.commit()
    log.info("bitrix close notice request_id=%s", request_id)
