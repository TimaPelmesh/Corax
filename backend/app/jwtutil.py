"""JWT encode/decode via PyJWT (replaces python-jose)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from jwt.exceptions import InvalidTokenError as JWTError

from app.config import settings

__all__ = ["JWTError", "decode_token", "encode_token"]


def encode_token(payload: dict[str, Any]) -> str:
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_token(token: str) -> dict[str, Any]:
    data = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    if not isinstance(data, dict):
        raise JWTError("Invalid token payload")
    return data


def access_token_payload(subject: str, token_version: int = 0) -> dict[str, Any]:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return {"sub": subject, "ver": int(token_version or 0), "exp": expire}
