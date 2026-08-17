"""Runtime WikiRAG options (persisted JSON, overrides env defaults)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.config import settings

_OPTIONS_NAME = "wiki_rag_options.json"


def _options_path() -> Path:
    base = Path(settings.wiki_rag_dir)
    if not base.is_absolute():
        base = Path(__file__).resolve().parent.parent / base
    base.mkdir(parents=True, exist_ok=True)
    return base / _OPTIONS_NAME


def _read_options() -> dict[str, Any]:
    path = _options_path()
    try:
        if path.is_file():
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return raw
    except (OSError, json.JSONDecodeError, TypeError):
        pass
    return {}


def _write_options(data: dict[str, Any]) -> None:
    path = _options_path()
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def get_auto_index() -> bool:
    """Whether upload/edit/import should queue indexing automatically."""
    data = _read_options()
    if "auto_index" in data:
        return bool(data["auto_index"])
    return bool(getattr(settings, "wiki_rag_auto_index", False))


def set_auto_index(enabled: bool) -> bool:
    data = _read_options()
    data["auto_index"] = bool(enabled)
    _write_options(data)
    return bool(enabled)


def get_embed_model() -> str:
    """Embedding model for WikiRAG indexing (separate from chat LLM)."""
    data = _read_options()
    raw = data.get("embed_model")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()[:256]
    return (getattr(settings, "wiki_rag_embed_model", None) or "bge-m3").strip() or "bge-m3"


def set_embed_model(model: str | None) -> str:
    data = _read_options()
    cleaned = (model or "").strip()[:256]
    if cleaned:
        data["embed_model"] = cleaned
    else:
        data.pop("embed_model", None)
    _write_options(data)
    return get_embed_model()
