"""Short memory for identical panel reads.

Opening one screen fires the same GET from the page, the badges, and a retry.
Each of those used to take its own database connection and sit in the pool
until the slowest one finished. One of them talks to Postgres; the rest wait
for that answer. A write drops the memory so the next read is fresh.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any

from app.config import settings

_TTL_SECONDS = 8.0
_MAX_BODY = 1_200_000
# Fifty people each open a handful of screens. 48 entries used to evict the
# answer before the next tab asked for it, so every user hit Postgres again.
_MAX_ENTRIES = 800

# Fleet reads are the same for every signed-in panel user. One query serves
# the burst; notes, badges and "assigned to me" stay per session.
_SHARED_PREFIXES = (
    "/api/v1/computers",
    "/api/v1/printers",
    "/api/v1/network/devices",
    "/api/v1/network/topology",
    "/api/v1/software",
    "/api/v1/monitors",
    "/api/v1/tags",
    "/api/v1/warehouse",
)

# List and summary reads. Job status, agents, health, and downloads stay live.
_PREFIXES = (
    "/api/v1/dashboard/summary",
    "/api/v1/dashboard/nav-badges",
    "/api/v1/dashboard/calendar",
    "/api/v1/computers",
    "/api/v1/printers",
    "/api/v1/network/devices",
    "/api/v1/network/topology",
    "/api/v1/service-requests",
    "/api/v1/software",
    "/api/v1/notes",
    "/api/v1/warehouse",
    "/api/v1/monitors",
    "/api/v1/tags",
)

_UNSAFE = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# key -> (expires_at, status, headers, body)
_STORE: dict[bytes, tuple[float, int, list[tuple[bytes, bytes]], bytes]] = {}
_LOCKS: dict[bytes, Any] = {}


def _enabled() -> bool:
    return (settings.environment or "").strip().lower() != "test"


def _path_of(scope) -> str:
    return scope.get("path") or ""


def _cacheable(scope) -> bool:
    if not _enabled():
        return False
    if scope.get("method") != "GET":
        return False
    path = _path_of(scope)
    if not any(path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "?") for prefix in _PREFIXES):
        return False
    lowered = path.lower()
    if any(part in lowered for part in ("/export", "/download", "/csv", "/job-status")):
        return False
    return True


def _shared_path(path: str) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in _SHARED_PREFIXES)


def _presented_token(scope) -> str:
    """Cookie or bearer the panel already sent. Empty when the request is anonymous."""
    from urllib.parse import unquote

    cookie = ""
    authorization = ""
    for name, value in scope.get("headers") or []:
        low = name.lower()
        if low == b"cookie":
            cookie = value.decode("latin1", "replace")
        elif low == b"authorization":
            authorization = value.decode("latin1", "replace")
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    for part in cookie.split(";"):
        item = part.strip()
        if item.lower().startswith("access_token="):
            return unquote(item.split("=", 1)[1]).strip().strip('"')
    return ""


def _signed_session(scope) -> bool:
    """A garbage cookie must not read the fleet answer another user just cached."""
    token = _presented_token(scope)
    if not token:
        return False
    try:
        from app.jwtutil import decode_token

        decode_token(token)
    except Exception:
        return False
    return True


def _key(scope) -> bytes:
    path = _path_of(scope)
    query = scope.get("query_string") or b""
    if _shared_path(path) and _signed_session(scope):
        return b"s|" + path.encode() + b"?" + query
    cookie = b""
    for name, value in scope.get("headers") or []:
        if name.lower() == b"cookie":
            cookie = value
            break
    digest = hashlib.sha256(cookie).hexdigest()[:16].encode()
    return path.encode() + b"?" + query + b"|" + digest


def _lookup(key: bytes):
    hit = _STORE.get(key)
    if hit is None:
        return None
    if hit[0] <= time.monotonic():
        _STORE.pop(key, None)
        return None
    return hit


def _json_body(headers: list[tuple[bytes, bytes]]) -> bool:
    for name, value in headers:
        if name.lower() == b"content-type":
            return b"application/json" in value.lower()
    return False


def _remember(key: bytes, status: int, headers: list[tuple[bytes, bytes]], body: bytes, *, skip: bool = False) -> None:
    now = time.monotonic()
    # Status 0 means "do not keep this answer". Later readers skip the lock
    # and talk to the handler themselves instead of queueing behind it.
    if skip or status != 200 or len(body) > _MAX_BODY or not _json_body(headers):
        _STORE[key] = (now + _TTL_SECONDS, 0, [], b"")
        return
    kept: list[tuple[bytes, bytes]] = []
    for name, value in headers:
        low = name.lower()
        if low in {b"content-length", b"set-cookie", b"transfer-encoding"}:
            continue
        kept.append((name, value))
    kept.append((b"content-length", str(len(body)).encode()))
    _STORE[key] = (now + _TTL_SECONDS, status, kept, body)
    if len(_STORE) <= _MAX_ENTRIES:
        return
    oldest = min(_STORE, key=lambda item: _STORE[item][0])
    _STORE.pop(oldest, None)


def _drop_all() -> None:
    _STORE.clear()


async def _emit(send, status: int, headers, body: bytes) -> None:
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body, "more_body": False})


class PanelReadCacheMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        method = scope.get("method") or "GET"
        if method in _UNSAFE:
            path = _path_of(scope)
            # Agents and Bitrix write all day. Dropping the panel memory on
            # each of those would throw away the answer the screen just got.
            if not path.startswith(("/api/v1/agent", "/api/v1/bitrix", "/api/v1/health")):
                _drop_all()
            await self.app(scope, receive, send)
            return
        if not _cacheable(scope):
            await self.app(scope, receive, send)
            return

        import asyncio

        key = _key(scope)
        hit = _lookup(key)
        if hit is not None and hit[1] == 0:
            await self.app(scope, receive, send)
            return
        if hit is not None:
            await _emit(send, hit[1], hit[2], hit[3])
            return

        lock = _LOCKS.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _LOCKS[key] = lock
            if len(_LOCKS) > 200:
                _LOCKS.clear()
                _LOCKS[key] = lock

        async with lock:
            hit = _lookup(key)
            if hit is not None and hit[1] == 0:
                pass
            elif hit is not None:
                await _emit(send, hit[1], hit[2], hit[3])
                return
            else:
                status = 0
                headers: list[tuple[bytes, bytes]] = []
                chunks: list[bytes] = []
                captured = 0
                too_big = False

                async def send_wrap(message):
                    nonlocal status, headers, captured, too_big
                    kind = message["type"]
                    if kind == "http.response.start":
                        status = int(message["status"])
                        headers = list(message.get("headers") or [])
                        await send(message)
                        return
                    if kind == "http.response.body":
                        chunk = message.get("body") or b""
                        if chunk and not too_big:
                            captured += len(chunk)
                            if captured <= _MAX_BODY:
                                chunks.append(chunk)
                            else:
                                too_big = True
                                chunks.clear()
                        await send(message)
                        if not message.get("more_body", False):
                            _remember(key, status, headers, b"".join(chunks), skip=too_big)
                        return
                    await send(message)

                await self.app(scope, receive, send_wrap)
                return

        await self.app(scope, receive, send)
