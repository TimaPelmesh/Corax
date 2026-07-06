"""PostgreSQL TEXT/VARCHAR cannot store U+0000; agent/registry data may contain it."""
from __future__ import annotations

from typing import Any

_NUL = "\x00"


def strip_nul_text(value: str | None) -> str | None:
    if value is None:
        return None
    if _NUL not in value:
        return value
    cleaned = value.replace(_NUL, "")
    return cleaned if cleaned else None


def deep_strip_nul(value: Any) -> Any:
    if isinstance(value, str):
        cleaned = strip_nul_text(value)
        return cleaned if cleaned is not None else ""
    if isinstance(value, dict):
        return {k: deep_strip_nul(v) for k, v in value.items()}
    if isinstance(value, list):
        return [deep_strip_nul(v) for v in value]
    return value
