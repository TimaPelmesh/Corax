"""In-memory Corax Assist sessions: offer, consent, JPEG frames, input.

Video stays on the LAN server. The employee tray must accept before frames flow.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from collections import deque
from dataclasses import dataclass, field

from fastapi import WebSocket

OFFER_TTL_SEC = 90
SESSION_TTL_SEC = 20 * 60
MAX_FRAME_BYTES = 400_000
MAX_INPUT_QUEUE = 64
WAIT_OFFER_SEC = 25.0


@dataclass
class AssistSession:
    id: str
    hostname: str
    admin_id: int
    admin_name: str
    status: str
    created: float
    inputs: deque[dict] = field(default_factory=deque)
    admins: list[WebSocket] = field(default_factory=list)


class AssistHub:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._sessions: dict[str, AssistSession] = {}
        self._wake: dict[str, asyncio.Event] = {}

    def _host_key(self, hostname: str) -> str:
        return (hostname or "").strip().lower()

    def _aliases(self, hostname: str) -> set[str]:
        key = self._host_key(hostname)
        if not key:
            return set()
        names = {key, key.split(".", 1)[0]}
        names.discard("")
        return names

    def hosts_match(self, left: str, right: str) -> bool:
        return bool(self._aliases(left) & self._aliases(right))

    def _wake_for(self, host_key: str) -> asyncio.Event:
        ev = self._wake.get(host_key)
        if ev is None:
            ev = asyncio.Event()
            self._wake[host_key] = ev
        return ev

    def _purge_locked(self, now: float) -> None:
        dead = []
        for sid, sess in self._sessions.items():
            ttl = OFFER_TTL_SEC if sess.status == "offered" else SESSION_TTL_SEC
            if now - sess.created > ttl or sess.status in {"denied", "ended"}:
                if sess.status == "offered" and now - sess.created > ttl:
                    sess.status = "ended"
                if sess.status in {"denied", "ended"} or now - sess.created > ttl:
                    dead.append(sid)
        for sid in dead:
            self._sessions.pop(sid, None)

    async def create(self, hostname: str, admin_id: int, admin_name: str) -> AssistSession:
        key = self._host_key(hostname)
        if not key:
            raise ValueError("hostname")
        now = time.monotonic()
        async with self._lock:
            self._purge_locked(now)
            for sess in self._sessions.values():
                if self.hosts_match(sess.hostname, key) and sess.status in {"offered", "accepted", "live"}:
                    if sess.status == "live" or sess.status == "accepted":
                        raise RuntimeError("busy")
                    sess.status = "ended"
            sess = AssistSession(
                id=secrets.token_urlsafe(12),
                hostname=key,
                admin_id=admin_id,
                admin_name=(admin_name or "").strip()[:80] or "администратор",
                status="offered",
                created=now,
            )
            self._sessions[sess.id] = sess
            for alias in self._aliases(key):
                self._wake_for(alias).set()
            return sess

    async def wait_offer(self, hostname: str, timeout: float = WAIT_OFFER_SEC) -> AssistSession | None:
        key = self._host_key(hostname)
        if not key:
            return None
        deadline = time.monotonic() + max(1.0, timeout)
        while True:
            now = time.monotonic()
            async with self._lock:
                self._purge_locked(now)
                for sess in self._sessions.values():
                    if sess.status == "offered" and self.hosts_match(sess.hostname, key):
                        return sess
                remaining = deadline - now
                if remaining <= 0:
                    return None
                ev = self._wake_for(key)
                ev.clear()
            try:
                await asyncio.wait_for(ev.wait(), remaining)
            except (TimeoutError, asyncio.TimeoutError):
                return None

    async def get(self, session_id: str) -> AssistSession | None:
        async with self._lock:
            self._purge_locked(time.monotonic())
            return self._sessions.get(session_id)

    async def answer(self, session_id: str, hostname: str, accept: bool) -> AssistSession | None:
        key = self._host_key(hostname)
        async with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None or not self.hosts_match(sess.hostname, key):
                return None
            if sess.status not in {"offered", "accepted"}:
                return None
            sess.status = "accepted" if accept else "denied"
            if not accept:
                sess.status = "denied"
            return sess

    async def end(self, session_id: str) -> AssistSession | None:
        async with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                return None
            sess.status = "ended"
            admins = list(sess.admins)
            sess.admins.clear()
        for ws in admins:
            try:
                await ws.close()
            except Exception:
                pass
        return sess

    async def attach_admin(self, session_id: str, ws: WebSocket) -> AssistSession | None:
        async with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None or sess.status in {"denied", "ended"}:
                return None
            sess.admins.append(ws)
            return sess

    async def detach_admin(self, session_id: str, ws: WebSocket) -> None:
        async with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                return
            sess.admins = [item for item in sess.admins if item is not ws]

    async def push_frame(self, session_id: str, hostname: str, frame: bytes) -> list[dict]:
        if not frame or len(frame) > MAX_FRAME_BYTES:
            return []
        key = self._host_key(hostname)
        async with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None or not self.hosts_match(sess.hostname, key):
                return []
            if sess.status not in {"accepted", "live"}:
                return []
            sess.status = "live"
            admins = list(sess.admins)
            events = list(sess.inputs)
            sess.inputs.clear()
        stale: list[WebSocket] = []
        for ws in admins:
            try:
                await ws.send_bytes(frame)
            except Exception:
                stale.append(ws)
        if stale:
            async with self._lock:
                sess = self._sessions.get(session_id)
                if sess is not None:
                    sess.admins = [item for item in sess.admins if item not in stale]
        return events

    async def push_input(self, session_id: str, events: list[dict]) -> bool:
        async with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None or sess.status not in {"accepted", "live"}:
                return False
            for item in events:
                if len(sess.inputs) >= MAX_INPUT_QUEUE:
                    sess.inputs.popleft()
                sess.inputs.append(item)
            return True

    def public(self, sess: AssistSession) -> dict:
        return {
            "id": sess.id,
            "hostname": sess.hostname,
            "admin_name": sess.admin_name,
            "status": sess.status,
        }


hub = AssistHub()
