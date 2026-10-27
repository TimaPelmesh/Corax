"""Pull imbot.v2 events the way the working desktop bot does.

eventMode fetch leaves events in a queue. Corax reads them with
imbot.v2.Event.get, so Bitrix does not have to call this server.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.imbot_v2 import ImbotError
from app.imbot_v2 import call as imbot_call
from app.imbot_v2 import parse_fetch_event
from app.models import Bitrix24Config
from app.routers.bitrix24_bot_handler import _bot_talks, _handle_v2, publish_menu

log = logging.getLogger("corax.bitrix.bot")
POLL_SECONDS = 2
_fetch_switched = False
_menu_published: set[int] = set()


class BitrixBotPoller:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="bitrix-bot-poll")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                async with AsyncSessionLocal() as db:
                    await poll_once(db)
            except Exception as exc:
                log.warning("bitrix poll failed: %s", exc.__class__.__name__)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                pass


bitrix_bot_poller = BitrixBotPoller()


def next_offset(result: dict[str, Any], events: list[Any]) -> int | None:
    raw = result.get("nextOffset")
    if raw is not None and str(raw).strip().isdigit():
        return int(str(raw).strip())
    ids = [
        int(item["eventId"])
        for item in events
        if isinstance(item, dict) and str(item.get("eventId") or "").strip().isdigit()
    ]
    if ids:
        return max(ids) + 1
    return None


def wants_fetch(cfg: Bitrix24Config) -> bool:
    """Webhook mode delivers events to the handler. Fetch is the queue Corax polls."""
    return (getattr(cfg, "bot_event_mode", None) or "fetch").strip().lower() != "webhook"


async def _ensure_fetch(cfg: Bitrix24Config) -> None:
    """An already registered webhook bot starts queueing only after this switch."""
    global _fetch_switched
    if _fetch_switched or not wants_fetch(cfg):
        return
    try:
        await imbot_call(
            cfg.bot_webhook_url or "",
            "imbot.v2.Bot.update",
            {
                "botId": int(cfg.bot_id or 0),
                "botToken": cfg.bot_token,
                "fields": {"eventMode": "fetch"},
            },
        )
    except ImbotError as exc:
        log.warning("bitrix fetch mode failed code=%s", exc.code)
        return
    _fetch_switched = True


async def poll_once(db: AsyncSession) -> None:
    cfg = await db.get(Bitrix24Config, 1)
    if cfg is None or not _bot_talks(cfg):
        return
    if not (cfg.bot_webhook_url or "").strip() or not (cfg.bot_token or "").strip():
        return
    if not wants_fetch(cfg):
        return
    await _ensure_fetch(cfg)
    bot_id = int(cfg.bot_id or 0)
    if bot_id and bot_id not in _menu_published and await publish_menu(cfg):
        _menu_published.add(bot_id)
    for _ in range(5):
        payload: dict[str, Any] = {
            "botId": int(cfg.bot_id or 0),
            "botToken": cfg.bot_token,
            "limit": 50,
        }
        if cfg.bot_event_offset is not None:
            payload["offset"] = int(cfg.bot_event_offset)
        try:
            result = await imbot_call(cfg.bot_webhook_url or "", "imbot.v2.Event.get", payload)
        except ImbotError as exc:
            log.warning("bitrix event get failed code=%s", exc.code)
            return
        events = result.get("events") if isinstance(result.get("events"), list) else []
        for event in events:
            if not isinstance(event, dict):
                continue
            parsed = parse_fetch_event(event)
            if parsed is None:
                continue
            await _handle_v2(db, cfg, parsed)
        nxt = next_offset(result, events)
        if nxt is not None and nxt != cfg.bot_event_offset:
            cfg.bot_event_offset = nxt
            await db.commit()
        if not result.get("hasMore"):
            return
