"""Pull imbot.v2 events the way the working desktop bot does.

eventMode fetch leaves events in a queue. Corax reads them with
imbot.v2.Event.get, so Bitrix does not have to call this server.
"""

from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace
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

    def running(self) -> bool:
        return self._task is not None and not self._task.done()

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

    async def restart(self) -> None:
        """Stop the queue reader and start it again so the next pull uses fresh settings."""
        await self.stop()
        await self.start()

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await poll_once()
            except Exception as exc:
                log.warning("bitrix poll failed: %s", exc.__class__.__name__)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                pass


bitrix_bot_poller = BitrixBotPoller()
_reload_lock = asyncio.Lock()


async def reload_worker() -> None:
    """Restart the bot reader after an applied phrase change.

    Fetch mode and the command menu are registered again on the next pull.
    A process that never started the reader is left alone.
    """
    async with _reload_lock:
        global _fetch_switched
        was_running = bitrix_bot_poller.running()
        _fetch_switched = False
        _menu_published.clear()
        if not was_running:
            return
        log.info("bitrix bot worker restart")
        await bitrix_bot_poller.restart()


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


def _bot_snapshot(cfg: Bitrix24Config) -> SimpleNamespace | None:
    if not _bot_talks(cfg):
        return None
    if not (cfg.bot_webhook_url or "").strip() or not (cfg.bot_token or "").strip():
        return None
    if not wants_fetch(cfg):
        return None
    return SimpleNamespace(
        bot_webhook_url=cfg.bot_webhook_url,
        bot_token=cfg.bot_token,
        bot_id=cfg.bot_id,
        bot_event_offset=cfg.bot_event_offset,
        bot_event_mode=getattr(cfg, "bot_event_mode", None),
        bot_paused=cfg.bot_paused,
    )


async def poll_once(db: AsyncSession | None = None) -> None:
    """Read the bot row, then talk to Bitrix with no connection checked out.

    The old loop kept a pool slot for the whole HTTP round trip, every two
    seconds. A slow Bitrix left the panel waiting on that slot.
    """
    if db is not None:
        cfg = await db.get(Bitrix24Config, 1, populate_existing=True)
        snap = _bot_snapshot(cfg) if cfg is not None else None
    else:
        async with AsyncSessionLocal() as session:
            cfg = await session.get(Bitrix24Config, 1, populate_existing=True)
            snap = _bot_snapshot(cfg) if cfg is not None else None
    if snap is None:
        return
    await _poll_remote(snap)


async def _poll_remote(snap: SimpleNamespace) -> None:
    await _ensure_fetch(snap)  # type: ignore[arg-type]
    bot_id = int(snap.bot_id or 0)
    if bot_id and bot_id not in _menu_published and await publish_menu(snap):  # type: ignore[arg-type]
        _menu_published.add(bot_id)
    offset = snap.bot_event_offset
    for _ in range(5):
        payload: dict[str, Any] = {
            "botId": bot_id,
            "botToken": snap.bot_token,
            "limit": 50,
        }
        if offset is not None:
            payload["offset"] = int(offset)
        try:
            result = await imbot_call(snap.bot_webhook_url or "", "imbot.v2.Event.get", payload)
        except ImbotError as exc:
            log.warning("bitrix event get failed code=%s", exc.code)
            return
        events = result.get("events") if isinstance(result.get("events"), list) else []
        parsed_events = []
        for event in events:
            if not isinstance(event, dict):
                continue
            parsed = parse_fetch_event(event)
            if parsed is not None:
                parsed_events.append(parsed)
        nxt = next_offset(result, events)
        if parsed_events or (nxt is not None and nxt != offset):
            async with AsyncSessionLocal() as db:
                cfg = await db.get(Bitrix24Config, 1, populate_existing=True)
                if cfg is None:
                    return
                for parsed in parsed_events:
                    await _handle_v2(db, cfg, parsed)
                if nxt is not None and nxt != cfg.bot_event_offset:
                    cfg.bot_event_offset = nxt
                    await db.commit()
        if nxt is not None:
            offset = nxt
        if not result.get("hasMore"):
            return
