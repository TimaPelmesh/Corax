"""PostgreSQL TEXT/VARCHAR cannot store U+0000; SNMP/agent data may contain it."""
from __future__ import annotations

from typing import Any

_NUL = "\x00"
_KEEP_CTRL = frozenset("\t\n\r")


def pg_text(value: object, *, max_len: int | None = None) -> str | None:
    """UTF-8-safe text for PostgreSQL: no NUL, no other C0 controls, optional length."""
    if value is None:
        return None
    if isinstance(value, bytes):
        text = None
        for enc in ("utf-8", "cp866", "cp1251", "latin-1"):
            try:
                text = value.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            text = value.decode("latin-1", errors="replace")
    else:
        text = str(value)
    if _NUL in text:
        text = text.replace(_NUL, "")
    if any(ord(ch) < 32 and ch not in _KEEP_CTRL for ch in text):
        text = "".join(ch for ch in text if ord(ch) >= 32 or ch in _KEEP_CTRL)
    text = text.strip()
    if max_len is not None:
        text = text[:max_len]
    return text or None


def strip_nul_text(value: str | None) -> str | None:
    return pg_text(value)


def like_contains(value: str) -> str:
    """Literal substring for ILIKE: user %/_ are not wildcards."""
    cleaned = (pg_text(value) or "").strip()
    escaped = cleaned.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def deep_strip_nul(value: Any) -> Any:
    if isinstance(value, str):
        cleaned = pg_text(value)
        return cleaned if cleaned is not None else ""
    if isinstance(value, bytes):
        cleaned = pg_text(value)
        return cleaned if cleaned is not None else ""
    if isinstance(value, dict):
        return {k: deep_strip_nul(v) for k, v in value.items()}
    if isinstance(value, list):
        return [deep_strip_nul(v) for v in value]
    return value
