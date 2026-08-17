"""In-memory WebSocket hub: глобальное присутствие по live-карте (все этажи) и уведомления об автосохранении."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass

from fastapi import WebSocket
from jose import JWTError, jwt
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.models import User

log = logging.getLogger(__name__)


async def user_from_access_token(token: str | None) -> User | None:
    if not token or not str(token).strip():
        return None
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        sub = payload.get("sub")
        if sub is None or not isinstance(sub, str):
            return None
    except JWTError:
        return None
    async with AsyncSessionLocal() as db:
        r = await db.execute(select(User).where(User.username == sub))
        u = r.scalar_one_or_none()
        if u is None or not u.is_active:
            return None
        return u


@dataclass
class DiagramRoomClient:
    ws: WebSocket
    user_id: int
    username: str
    display_name: str


class DiagramLiveHub:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._rooms: dict[int, list[DiagramRoomClient]] = {}

    def _collect_global_peers_locked(self) -> list[dict]:
        """Вызывать только под self._lock."""
        seen: set[int] = set()
        peers: list[dict] = []
        for lst in self._rooms.values():
            for c in lst:
                if c.user_id in seen:
                    continue
                seen.add(c.user_id)
                peers.append(
                    {
                        "user_id": c.user_id,
                        "username": c.username,
                        "full_name": (c.display_name or None) or None,
                    }
                )
        return peers

    async def _peers_payload(self, diagram_id: int) -> str:
        """Список уникальных пользователей по всем комнатам live-карты (не только текущий этаж)."""
        async with self._lock:
            peer_list = self._collect_global_peers_locked()
        return json.dumps({"type": "presence", "diagram_id": diagram_id, "peers": peer_list}, ensure_ascii=False)

    async def _broadcast_presence_all_rooms(self) -> None:
        async with self._lock:
            peer_list = self._collect_global_peers_locked()
            diagram_ids = list(self._rooms.keys())
        for did in diagram_ids:
            text = json.dumps({"type": "presence", "diagram_id": did, "peers": peer_list}, ensure_ascii=False)
            await self._broadcast_text(did, text)

    async def register(self, diagram_id: int, client: DiagramRoomClient) -> None:
        async with self._lock:
            self._rooms.setdefault(diagram_id, []).append(client)
        await self._broadcast_presence_all_rooms()

    async def unregister(self, diagram_id: int, client: DiagramRoomClient) -> None:
        async with self._lock:
            lst = self._rooms.get(diagram_id, [])
            nxt = [x for x in lst if x.ws is not client.ws]
            if nxt:
                self._rooms[diagram_id] = nxt
            elif diagram_id in self._rooms:
                del self._rooms[diagram_id]
        await self._broadcast_presence_all_rooms()

    async def _client_snapshot(self, diagram_id: int) -> list[DiagramRoomClient]:
        async with self._lock:
            return list(self._rooms.get(diagram_id, []))

    async def _broadcast_text(self, diagram_id: int, text: str) -> None:
        clients = await self._client_snapshot(diagram_id)
        for c in clients:
            try:
                await c.ws.send_text(text)
            except Exception as e:  # noqa: BLE001 — сокет мог уже закрыться
                log.debug("diagram live send skip: %s", e)

    async def broadcast_layout_changed(self, diagram_id: int, username: str, full_name: str | None) -> None:
        msg = json.dumps(
            {
                "type": "layout_changed",
                "diagram_id": diagram_id,
                "by": {"username": username, "full_name": full_name},
            },
            ensure_ascii=False,
        )
        await self._broadcast_text(diagram_id, msg)

    async def relay_icon_drag(self, diagram_id: int, sender: DiagramRoomClient, icons: list[dict]) -> None:
        """Эфемерные координаты во время перетаскивания — без записи в БД, только соседям по WS."""
        msg = json.dumps(
            {
                "type": "icon_drag",
                "diagram_id": diagram_id,
                "user_id": sender.user_id,
                "username": sender.username,
                "icons": icons,
            },
            ensure_ascii=False,
        )
        clients = await self._client_snapshot(diagram_id)
        for c in clients:
            if c.ws is sender.ws:
                continue
            try:
                await c.ws.send_text(msg)
            except Exception as e:  # noqa: BLE001
                log.debug("diagram live icon_drag send skip: %s", e)

    async def broadcast_peer_activity(self, diagram_id: int, sender: DiagramRoomClient, kind: str) -> None:
        safe_kind = (kind or "").strip()[:64] or "edit"
        msg = json.dumps(
            {
                "type": "peer_editing",
                "diagram_id": diagram_id,
                "user": {
                    "user_id": sender.user_id,
                    "username": sender.username,
                    "full_name": (sender.display_name or None) or None,
                },
                "kind": safe_kind,
            },
            ensure_ascii=False,
        )
        clients = await self._client_snapshot(diagram_id)
        for c in clients:
            if c.ws is sender.ws:
                continue
            try:
                await c.ws.send_text(msg)
            except Exception as e:  # noqa: BLE001
                log.debug("diagram live activity send skip: %s", e)


diagram_live_hub = DiagramLiveHub()
