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
    """Совпадает с Ollama num_ctx (0 в .env = авто / кэш / 16384)."""
    from app.wikirag_lm import ollama_num_ctx

    return ollama_num_ctx()


def lm_output_token_reserve() -> int:
    cap = int(getattr(settings, "lm_studio_max_tokens", None) or 2048)
    # Резерв под ответ — не сжимать вход до обрыва генерации.
    return min(max(cap, 768), 4096)


def prompt_token_budget(*, extra_reserve: int = 120) -> int:
    return max(800, lm_context_token_limit() - lm_output_token_reserve() - extra_reserve)


def chars_for_tokens(tokens: int) -> int:
    return max(400, int(tokens * 2.2))


def is_context_overflow_error(detail: str) -> bool:
    return bool(_CONTEXT_ERR_RE.search(detail or ""))


def human_lm_studio_error(
    status_code: int,
    detail: str,
    *,
    provider: str | None = None,
) -> str:
    d = (detail or "").strip()
    low = d.lower()
    label = "локальная LLM"
    if provider == "ollama":
        label = "Ollama"
    elif provider == "lm_studio":
        label = "LM Studio"

    if is_context_overflow_error(d):
        ctx_hint = (
            "увеличьте контекст в Настройки → LLM (например 16384 / 32768) или num_ctx у Ollama."
            if provider == "ollama"
            else "увеличьте контекст в Настройки → LLM и Context Length в LM Studio (например ≥ 16384)."
        )
        return (
            "Запрос не влез в контекст модели. В CORAX лимит промпта ~20 000 токенов — "
            f"{ctx_hint} "
            "CORAX сжимает данные автоматически; если ошибка повторяется — отключите "
            "«Подмешивать CORAX» или упростите вопрос."
        )
    if _CHANNEL_ERR_RE.search(low):
        return (
            f"{label} оборвал ответ (Channel Error). Обычно: переполнен контекст или не хватает RAM. "
            "Перезапустите сервер модели, уменьшите Context или выберите модель полегче."
        )
    if status_code == 0:
        if d:
            return f"Нет связи с {label}: {d[:400]}"
        return f"Нет связи с {label}."
    if status_code == 504:
        return f"{label} не успел ответить (таймаут). Увеличьте timeout или упростите вопрос."
    if status_code in (502, 503):
        return f"{label} временно недоступен (HTTP {status_code}). Перезапустите сервер модели."
    if d:
        return f"{label} (HTTP {status_code}): {d[:400]}"
    return f"{label} вернул ошибку HTTP {status_code}."


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
    """Ужимает последнее user-сообщение: tool-блоки и wiki, вопрос сохраняем."""
    text = content or ""
    # Legacy markers (older prompts).
    if "Данные CORAX" in text:
        text = re.sub(
            r"Данные CORAX[\s\S]*?(?=\nЗагруженные документы:|\nВопрос:)",
            "Данные CORAX: (сжато — смотрите файлы CORAX_*.md в документах ниже)\n\n",
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

    # Current prompt shape: «Контекст:» + optional ### tool: blocks + «Вопрос:».
    if "Контекст:" in text:
        m = re.search(r"(Контекст:\n)([\s\S]*?)(\n\nВопрос:)", text)
        if m:
            body = m.group(2)
            # Prefer keeping live tool headers/totals; trim wiki / long tails first.
            tool_parts = re.split(r"(?=### tool:)", body)
            kept: list[str] = []
            budget = max(600, int(len(body) * keep_ratio))
            used = 0
            for part in tool_parts:
                if not part.strip():
                    continue
                # Keep first ~40 lines of search_computers / query_corax (totals + sample).
                if part.lstrip().startswith("### tool:search_computers") or part.lstrip().startswith(
                    "### tool:query_corax"
                ):
                    lines = part.splitlines()
                    part = "\n".join(lines[:40])
                    if len(lines) > 40:
                        part += "\n… [tool сжат]"
                elif part.lstrip().startswith("### tool:search_wiki") or not part.lstrip().startswith(
                    "### tool:"
                ):
                    max_wiki = max(400, budget // 3)
                    if len(part) > max_wiki:
                        part = part[: max_wiki - 20].rstrip() + "\n… [wiki сжато]"
                if used + len(part) + 2 > budget and kept:
                    break
                kept.append(part)
                used += len(part) + 2
            new_body = "\n\n".join(kept).strip() or "(контекст сжат)"
            text = text[: m.start(1)] + m.group(1) + new_body + m.group(3) + text[m.end(3) :]

    if estimate_tokens(text) > prompt_token_budget() and len(text) > 600:
        qm = re.search(r"\n\nВопрос:[\s\S]*$", text)
        tail = qm.group(0) if qm else ""
        head_budget = chars_for_tokens(prompt_token_budget() // 2)
        head = text[: max(200, head_budget - len(tail) - 30)].rstrip() + "\n… [контекст сжат]"
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
