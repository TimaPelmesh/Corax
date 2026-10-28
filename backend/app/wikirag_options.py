"""Runtime WikiRAG options (persisted JSON, overrides env defaults)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

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


_CTX_HARD_MAX = 32768


def clamp_lm_context_tokens(value: Any) -> int:
    """0 = авто. Иначе 2048…32768."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    if n <= 0:
        return 0
    return max(2048, min(n, _CTX_HARD_MAX))


def get_lm_context_tokens() -> int:
    """Лимит контекста чата / Ollama num_ctx. UI override бьёт .env. 0 = авто."""
    data = _read_options()
    if "lm_context_tokens" in data:
        return clamp_lm_context_tokens(data.get("lm_context_tokens"))
    return clamp_lm_context_tokens(getattr(settings, "wiki_rag_lm_context_tokens", None) or 0)


_SYSTEM_PROMPT_MAX = 8000


def get_system_prompt() -> str:
    """Пустая строка — вшитый промпт. Иначе текст, который задали в настройках."""
    data = _read_options()
    raw = data.get("system_prompt")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()[:_SYSTEM_PROMPT_MAX]
    return ""


def set_system_prompt(value: str | None) -> str:
    data = _read_options()
    cleaned = (value or "").strip()[:_SYSTEM_PROMPT_MAX]
    if cleaned:
        data["system_prompt"] = cleaned
    else:
        data.pop("system_prompt", None)
    _write_options(data)
    return get_system_prompt()


def set_lm_context_tokens(value: int | None) -> int:
    data = _read_options()
    if value is None:
        data.pop("lm_context_tokens", None)
    else:
        data["lm_context_tokens"] = clamp_lm_context_tokens(value)
    _write_options(data)
    return get_lm_context_tokens()


_MAX_LLM_SERVERS = 12
_SERVER_ID = re.compile(r"^[a-z0-9]{4,16}$")


def _label_from_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.hostname or url
    if parsed.port:
        return f"{host}:{parsed.port}"[:64]
    return host[:64]


def llm_servers_configured() -> bool:
    """True after the panel has saved the list, including an intentional empty one."""
    raw = _read_options().get("llm_servers")
    return isinstance(raw, list)


def get_llm_servers() -> list[dict[str, str]]:
    """Named OpenAI-compatible endpoints. Chat and embeddings pick from this list."""
    data = _read_options()
    raw = data.get("llm_servers")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        sid = str(item.get("id") or "").strip().lower()
        url = str(item.get("base_url") or "").strip()
        label = " ".join(str(item.get("label") or "").split())
        if not _SERVER_ID.fullmatch(sid) or not url.startswith(("http://", "https://")):
            continue
        out.append({"id": sid, "label": (label or _label_from_url(url))[:64], "base_url": url[:512]})
        if len(out) >= _MAX_LLM_SERVERS:
            break
    return out


def set_llm_servers(servers: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Replace the endpoint list. URLs are checked the same way as a chat base URL."""
    from app.wikirag_lm import normalize_lm_base_url

    if len(servers) > _MAX_LLM_SERVERS:
        raise ValueError(f"Серверов может быть не больше {_MAX_LLM_SERVERS}.")
    cleaned: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    for item in servers:
        sid = str(item.get("id") or "").strip().lower()
        if not _SERVER_ID.fullmatch(sid):
            raise ValueError("Некорректный идентификатор сервера.")
        if sid in seen_ids:
            raise ValueError("Повторяется идентификатор сервера.")
        url = normalize_lm_base_url(str(item.get("base_url") or ""))
        if url in seen_urls:
            raise ValueError("Такой адрес сервера уже есть.")
        label = " ".join(str(item.get("label") or "").split())[:64]
        seen_ids.add(sid)
        seen_urls.add(url)
        cleaned.append({"id": sid, "label": label or _label_from_url(url), "base_url": url})
    data = _read_options()
    data["llm_servers"] = cleaned
    _write_options(data)
    return cleaned


def get_embed_base_url() -> str:
    """Embedding endpoint saved in the panel. Empty means the env / chat default."""
    data = _read_options()
    raw = data.get("embed_base_url")
    if isinstance(raw, str) and raw.strip().startswith(("http://", "https://")):
        return raw.strip()[:512]
    return ""


def set_embed_base_url(url: str | None) -> str:
    from app.wikirag_lm import normalize_lm_base_url

    data = _read_options()
    cleaned = (url or "").strip()
    if cleaned:
        cleaned = normalize_lm_base_url(cleaned)
        data["embed_base_url"] = cleaned
    else:
        data.pop("embed_base_url", None)
        cleaned = ""
    _write_options(data)
    return cleaned
