"""Оценка размера промпта и ужатие под слабые модели (4096 ctx)."""

from __future__ import annotations

import re
from typing import Any

from app.config import settings

_CONTEXT_ERR_RE = re.compile(
    r"exceeds the available context|context size|context length|too many tokens|n_ctx|token limit",
    re.IGNORECASE,
)
_CHANNEL_ERR_RE = re.compile(r"channel error", re.IGNORECASE)


def estimate_tokens(text: str) -> int:
    """Грубая оценка для RU + CSV (с запасом)."""
    if not text:
        return 0
    return max(1, int(len(text) / 2.2))


def estimate_messages_tokens(messages: list[dict[str, str]]) -> int:
    total = 0
    for m in messages:
        total += estimate_tokens(m.get("content") or "")
        total += 4
    return total


def lm_context_token_limit() -> int:
    return int(getattr(settings, "wiki_rag_lm_context_tokens", None) or 20_000)


def lm_output_token_reserve() -> int:
    cap = int(getattr(settings, "lm_studio_max_tokens", None) or 1536)
    return min(max(cap, 256), 2048)


def prompt_token_budget(*, extra_reserve: int = 120) -> int:
    return max(800, lm_context_token_limit() - lm_output_token_reserve() - extra_reserve)


def chars_for_tokens(tokens: int) -> int:
    return max(400, int(tokens * 2.2))


def is_context_overflow_error(detail: str) -> bool:
    return bool(_CONTEXT_ERR_RE.search(detail or ""))


def human_lm_studio_error(status_code: int, detail: str) -> str:
    d = (detail or "").strip()
    low = d.lower()
    if is_context_overflow_error(d):
        return (
            "Запрос не влез в контекст модели. В CORAX лимит промпта ~20 000 токенов — "
            "в LM Studio выставьте Context Length ≥ 20480. "
            "CORAX сжимает данные автоматически; если ошибка повторяется — отключите "
            "«Подмешивать CORAX» или упростите вопрос."
        )
    if _CHANNEL_ERR_RE.search(low):
        return (
            "LM Studio оборвал ответ (Channel Error). Обычно: переполнен контекст или не хватает RAM. "
            "Перезапустите Server в LM Studio, уменьшите Context или выберите модель полегче."
        )
    if status_code == 504:
        return "LM Studio не успел ответить (таймаут). Увеличьте Server Timeout или упростите вопрос."
    if status_code in (502, 503):
        return f"LM Studio временно недоступен (HTTP {status_code}). Перезапустите Local Server."
    if d:
        return f"LM Studio (HTTP {status_code}): {d[:400]}"
    return f"LM Studio вернул ошибку HTTP {status_code}."


def parse_lm_error_body(res_text: str, data: Any) -> str:
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err.get("code") or "")
        if isinstance(err, str):
            return err
        msg = data.get("message")
        if isinstance(msg, str):
            return msg
    return (res_text or "")[:600]


def shrink_user_content(content: str, *, keep_ratio: float = 0.5) -> str:
    """Ужимает последнее user-сообщение: сначала убирает CORAX, потом обрезает документы."""
    text = content or ""
    if "Данные CORAX" in text:
        text = re.sub(
            r"Данные CORAX[\s\S]*?(?=\nЗагруженные документы:|\nВопрос:)",
            "Данные CORAX: (сжато — смотрите файлы CORAX_*.csv в документах ниже)\n\n",
            text,
            count=1,
        )
    if "Загруженные документы" in text:
        m = re.search(r"(Загруженные документы:[\s\S]*?)(\n\nВопрос:)", text)
        if m:
            block = m.group(1)
            max_len = max(400, int(len(block) * keep_ratio))
            if len(block) > max_len:
                block = block[: max_len - 20].rstrip() + "\n… [документы обрезаны]"
            text = text[: m.start(1)] + block + m.group(2) + text[m.end(2) :]
    if estimate_tokens(text) > prompt_token_budget() and len(text) > 600:
        qm = re.search(r"\n\nВопрос:[\s\S]*$", text)
        tail = qm.group(0) if qm else ""
        head_budget = chars_for_tokens(prompt_token_budget() // 2)
        head = text[: head_budget - len(tail) - 30].rstrip() + "\n… [контекст сжат]"
        text = head + tail
    return text


def shrink_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    if not messages:
        return messages
    out = [dict(m) for m in messages]
    if out[-1].get("role") == "user":
        out[-1]["content"] = shrink_user_content(str(out[-1].get("content") or ""))
    if estimate_messages_tokens(out) > prompt_token_budget():
        system = out[0] if out and out[0].get("role") == "system" else None
        user = out[-1] if out[-1].get("role") == "user" else None
        if system and user:
            out = [system, user]
    return out
