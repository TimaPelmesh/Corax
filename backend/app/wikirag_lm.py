from __future__ import annotations

import json
import re
import time
from collections.abc import AsyncIterator
from typing import Any, Literal

import httpx

from app.config import settings
from app.wikirag_context_budget import shrink_messages

ChatMode = Literal["simple", "rag"]
QuestionFocus = Literal["os_hardware", "software", "tickets", "general"]

WIKIRAG_SYSTEM_RAG = """Ты полезный русскоязычный ассистент базы знаний CORAX.

Приоритет — факты из предоставленного контекста (WikiRAG / CORAX).
Если прямого ответа в базе знаний нет — так и скажи: «В базе знаний прямого ответа нет».
Затем можешь рассуждать и предложить гипотезу/рекомендацию, опираясь на те данные,
которые всё же есть в контексте (похожие записи, косвенные улики, статистика парка).
Чётко отделяй факты из контекста от своих выводов.
Не выдумывай конкретные hostname, IP, серийники и инвентарные факты, которых нет в контексте.
Отвечай только по-русски, без скрытых рассуждений."""

WIKIRAG_OS_GUIDANCE = ""

WIKIRAG_SYSTEM_SIMPLE = (
    "Ты помощник CORAX. Отвечай по-русски кратко и по делу, без JSON и без английских рассуждений."
)
WIKIRAG_SYSTEM_FAST = ""

# 0 в settings = авто (макс. контекст модели). Кэш: (base|model) → (expires_at, num_ctx)
_CTX_CACHE: dict[str, tuple[float, int]] = {}
_CTX_CACHE_TTL_SEC = 600.0
_AUTO_CTX_FALLBACK = 16384
_AUTO_CTX_HARD_MAX = 32768


def ollama_num_ctx() -> int:
    """Активный num_ctx: ручной из .env или последний авто-детект / fallback."""
    configured = int(getattr(settings, "wiki_rag_lm_context_tokens", None) or 0)
    if configured > 0:
        return max(2048, min(configured, _AUTO_CTX_HARD_MAX))
    # Берём самый свежий кэш (любая модель) — обычно одна LLM на инстанс.
    now = time.monotonic()
    best = 0
    for exp, ctx in _CTX_CACHE.values():
        if exp > now and ctx > best:
            best = ctx
    return best or _AUTO_CTX_FALLBACK


def _ollama_options(*, max_tokens: int, mode: ChatMode) -> dict[str, Any]:
    """options для Ollama: без num_ctx модель часто остаётся на 4096 → мусор на больших RAG-промптах."""
    return {
        "num_predict": max_tokens,
        "temperature": 0.2 if mode == "rag" else 0.25,
        "num_ctx": ollama_num_ctx(),
        "repeat_penalty": 1.08,
    }


def completion_max_tokens(
    *,
    mode: ChatMode,
    response_mode: str = "fast",
    last_user_chars: int = 0,
) -> int:
    """Бюджет ответа: достаточно для списка hostname, но не съедает всё окно."""
    configured = int(settings.lm_studio_max_tokens or 2048)
    max_tokens = max(768, configured)
    rm = (response_mode or "fast").strip().lower()
    if mode == "rag":
        floor = 1536 if rm == "detailed" else 1024
        max_tokens = max(max_tokens, floor)
    else:
        max_tokens = min(max(max_tokens, 512), 1024)
        if last_user_chars < 80:
            max_tokens = min(max_tokens, 768)
    ctx = ollama_num_ctx()
    hard_cap = max(512, min(4096, ctx // 5))
    return max(512, min(max_tokens, hard_cap))


def _parse_model_context_length(payload: dict[str, Any]) -> int | None:
    """Достаёт context length из ответа Ollama /api/show.

    Приоритет: PARAMETER num_ctx из Modelfile (явный тюнинг) → architecture max.
    """
    params = payload.get("parameters")
    if isinstance(params, str):
        m = re.search(r"num_ctx\s+(\d+)", params, re.IGNORECASE)
        if m:
            try:
                n = int(m.group(1))
                if n >= 2048:
                    return n
            except ValueError:
                pass
    info = payload.get("model_info") if isinstance(payload.get("model_info"), dict) else {}
    for key, val in info.items():
        if str(key).endswith("context_length") or str(key).endswith(".context_length"):
            try:
                n = int(val)
                if n >= 2048:
                    return n
            except (TypeError, ValueError):
                continue
    details = payload.get("details") if isinstance(payload.get("details"), dict) else {}
    for key in ("context_length", "context"):
        try:
            n = int(details.get(key) or 0)
            if n >= 2048:
                return n
        except (TypeError, ValueError):
            continue
    return None


async def ensure_model_num_ctx(*, base_url: str | None, model: str | None) -> int:
    """0 в WIKI_RAG_LM_CONTEXT_TOKENS → спросить у Ollama максимум модели и закэшировать."""
    configured = int(getattr(settings, "wiki_rag_lm_context_tokens", None) or 0)
    if configured > 0:
        ctx = max(2048, min(configured, _AUTO_CTX_HARD_MAX))
        return ctx

    base = _base_url(base_url)
    provider = detect_llm_provider(base)
    picked = (model or "").strip() or (settings.lm_studio_model or "").strip() or "default"
    cache_key = f"{base}|{picked}"
    now = time.monotonic()
    hit = _CTX_CACHE.get(cache_key)
    if hit and hit[0] > now:
        return hit[1]

    ctx = _AUTO_CTX_FALLBACK
    if provider == "ollama":
        root = base[:-3] if base.lower().endswith("/v1") else base
        try:
            async with _lm_client(read=8.0) as client:
                res = await client.post(f"{root}/api/show", json={"name": picked})
                if res.status_code == 200:
                    data = res.json()
                    if isinstance(data, dict):
                        parsed = _parse_model_context_length(data)
                        if parsed:
                            ctx = max(2048, min(parsed, _AUTO_CTX_HARD_MAX))
        except Exception:
            pass
    _CTX_CACHE[cache_key] = (now + _CTX_CACHE_TTL_SEC, ctx)
    return ctx

_THINK_BLOCK_RE = re.compile(r"<\s*think\b[\s\S]*?<\s*/\s*think\s*>", re.IGNORECASE)
_THINK_OPEN_RE = re.compile(r"^<\s*think\b[\s\S]*", re.IGNORECASE)
_CYRILLIC_RE = re.compile(r"[а-яёА-ЯЁ]")
_REASONING_DUMP_MARKERS = (
    "here's a thinking",
    "thinking process",
    "**analyze the request",
    "self-correction",
    "simulate data analysis",
    "since no data is provided",
    "no actual image/data",
    "no actual data",
    "i must assume",
    "structure the response",
    "review constraints",
    "construct the suggested response",
)


def _cyrillic_char_ratio(text: str) -> float:
    if not text:
        return 0.0
    cyr = len(_CYRILLIC_RE.findall(text))
    return cyr / max(len(text), 1)


def _looks_like_reasoning_dump(text: str) -> bool:
    low = (text or "").strip().lower()
    if not low:
        return False
    if any(m in low for m in _REASONING_DUMP_MARKERS):
        return True
    head = low[:1200]
    if len(head) > 180 and _cyrillic_char_ratio(head) < 0.04:
        return True
    return False


def _extract_russian_answer(text: str) -> str:
    """Вырезает финальный русский ответ из reasoning-мусора модели."""
    blocks = re.split(r"\n\s*\n+", (text or "").strip())
    russian = [
        b.strip()
        for b in blocks
        if len(b.strip()) >= 30 and _cyrillic_char_ratio(b) >= 0.12
    ]
    if russian:
        return "\n\n".join(russian)
    return ""


def _strip_think_blocks(text: str) -> str:
    t = _THINK_BLOCK_RE.sub("", text or "").strip()
    if re.search(r"<\s*think\b", t, re.IGNORECASE):
        t = _THINK_OPEN_RE.sub("", t).strip()
    return t


def _sanitize_model_output(text: str) -> str:
    t = _strip_think_blocks((text or "").strip())
    if not t:
        return ""
    if _looks_like_reasoning_dump(t):
        extracted = _extract_russian_answer(t)
        if extracted:
            return extracted
        return ""
    return t


def is_bad_lm_answer(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if _looks_like_reasoning_dump(t):
        return True
    low = t.lower()
    if "no data is provided" in low or "no actual data" in low or ("данных нет" in low and len(t) < 120):
        return True
    if len(t) < 80 and _cyrillic_char_ratio(t) < 0.1:
        return True
    return False


def is_weak_or_truncated_answer(text: str, *, question: str = "") -> bool:
    """Только явный обрыв/мусор — не подменяем нормальный краткий анализ модели."""
    t = (text or "").strip()
    if is_bad_lm_answer(t):
        return True
    words = re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", t)
    # Типичный обрыв 1B: 5–12 слов без точки.
    if len(words) <= 12 and not re.search(r"[.!?…]", t):
        return True
    if re.search(r"(?:\s|^)(?:рес|достаточн\w*|профессион\w*)\s*$", t, re.IGNORECASE):
        return True
    last = words[-1].lower() if words else ""
    if len(words) <= 18 and last in {"рес", "для", "и", "на", "с", "в", "по", "не", "что", "как"}:
        return True
    return False


def normalize_lm_base_url(raw: str | None) -> str:
    base = (raw or settings.lm_studio_base_url or "http://127.0.0.1:1234/v1").strip()
    if not base:
        base = "http://127.0.0.1:1234/v1"
    if not re.match(r"^https?://", base, re.IGNORECASE):
        raise ValueError("URL локальной LLM должен начинаться с http:// или https://")
    base = base.rstrip("/")
    # Ollama native API is /api/*; OpenAI-compatible surface is /v1 (same as LM Studio).
    if not base.lower().endswith("/v1"):
        base = f"{base}/v1"
    return base.rstrip("/")


def detect_llm_provider(base_url: str | None) -> str:
    """Heuristic: Ollama (11434) vs LM Studio (1234) vs generic OpenAI-compatible."""
    raw = (base_url or "").strip().lower()
    if "11434" in raw or "ollama" in raw:
        return "ollama"
    if "1234" in raw or "lmstudio" in raw or "lm-studio" in raw:
        return "lm_studio"
    return "openai_compat"


def llm_provider_label(provider: str) -> str:
    if provider == "ollama":
        return "Ollama"
    if provider == "lm_studio":
        return "LM Studio"
    return "локальная LLM"


def _base_url(override: str | None = None) -> str:
    return normalize_lm_base_url(override)


def _lm_client(*, read: float) -> httpx.AsyncClient:
    # Важно: не использовать системный прокси (trust_env=False), иначе localhost → 504.
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=15.0, read=read, write=30.0, pool=15.0),
        trust_env=False,
    )


def classify_wikirag_question(question: str) -> QuestionFocus:
    low = (question or "").strip().lower()
    # ПО раньше «установ*», иначе «у кого установлено Chrome» уходит в os_hardware.
    if any(
        k in low
        for k in (
            "програм",
            " софт",
            "1с",
            "1c",
            "установлен",
            "установлено",
            "по на",
            "какое по",
            "dr.web",
            "dr web",
            "антивирус",
            "каспер",
            "office",
            "chrome",
            "firefox",
        )
    ):
        return "software"
    if any(k in low for k in ("заявк", "тикет", "обращен", "инцидент")):
        return "tickets"
    if any(
        k in low
        for k in (
            "windows",
            "виндов",
            "win10",
            "win 10",
            "win11",
            "win 11",
            "операцион",
            "обнов",
            "апгрейд",
            "ставить",
            "upgrade",
            "желез",
            "ram",
            "озу",
            "процессор",
            "cpu",
            "gpu",
            "видеокарт",
            "мощност",
            "слаб",
            "кому лучше",
            "кого обнов",
            "диск",
            "ssd",
            "hdd",
        )
    ):
        return "os_hardware"
    return "general"


def is_small_talk(question: str) -> bool:
    q = question.strip().lower().rstrip("?!.…")
    if len(q) > 60:
        return False
    exact = {
        "привет",
        "здравствуй",
        "здравствуйте",
        "hi",
        "hello",
        "hey",
        "ку",
        "хай",
        "добрый день",
        "доброе утро",
        "добрый вечер",
        "как дела",
        "что делаешь",
    }
    if q in exact:
        return True
    # Инвентарные / wiki-вопросы всегда идут в RAG (как в script.py).
    inventory_keys = (
        "пк",
        "комп",
        "хост",
        "hostname",
        "озу",
        "ram",
        "cpu",
        "gpu",
        "win",
        "windows",
        "принтер",
        "заявк",
        "тег",
        "софт",
        "по ",
        "установ",
        "слаб",
        "сколько",
        "найди",
        "кто ",
        "у кого",
        "где ",
        "какой",
        "какая",
        "какие",
        "список",
        "corax",
        "документ",
        "файл",
        "md",
    )
    if any(k in q for k in inventory_keys):
        return False
    if len(q.split()) <= 2:
        keywords = ("документ", "файл", "найди", "расскаж", "что в", "где ", "как ", "почему", "заявк", "инструк")
        return not any(k in q for k in keywords)
    return False


_LM_ERROR_MARKERS = (
    "ошибка связи с lm studio",
    "lm studio:",
    "http/status",
    "channel error",
    "таймаут 504",
    "client error",
    "server error",
)
_CHANNEL_ERR_RE = re.compile(r"channel error", re.IGNORECASE)


def _is_error_turn(content: str) -> bool:
    low = (content or "").strip().lower()
    if not low:
        return True
    return any(m in low for m in _LM_ERROR_MARKERS)


def sanitize_chat_history(history: list[dict[str, str]]) -> list[dict[str, str]]:
    """Только успешные пары user→assistant; ошибки и «висячие» user не уходят в LM Studio."""
    pending_user: dict[str, str] | None = None
    pairs: list[tuple[dict[str, str], dict[str, str]]] = []

    for h in history:
        role = (h.get("role") or "").strip()
        if role not in ("user", "assistant"):
            continue
        content = (h.get("content") or "").strip()[:1500]
        if not content:
            continue
        if role == "user":
            pending_user = {"role": "user", "content": content}
            continue
        if role == "assistant":
            if _is_error_turn(content) or pending_user is None:
                pending_user = None
                continue
            pairs.append(
                (pending_user, {"role": "assistant", "content": normalize_assistant_for_history(content)})
            )
            pending_user = None

    # Только последняя пара — меньше шума и быстрее; новый чат приходит с history=[].
    out: list[dict[str, str]] = []
    for u, a in pairs[-1:]:
        out.append(u)
        out.append(a)
    return out


def _rag_user_suffix(question: str, focus: QuestionFocus) -> str:
    del focus  # focus reserved for future routing hints in the suffix
    q = question.strip()
    return f"\n\nВопрос: {q}\n\nОтвет:"


def build_messages(
    question: str,
    documents_block: str,
    history: list[dict[str, str]],
    *,
    corax_block: str = "",
    mode: ChatMode = "rag",
    data_char_budget: int | None = None,
    question_focus: QuestionFocus | None = None,
    response_mode: str = "fast",
) -> list[dict[str, str]]:
    del response_mode
    focus = question_focus or classify_wikirag_question(question)
    system = WIKIRAG_SYSTEM_SIMPLE if mode == "simple" else WIKIRAG_SYSTEM_RAG
    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    hist = [] if mode == "simple" else sanitize_chat_history(history)
    for h in hist:
        role = h.get("role") or "user"
        if role not in ("user", "assistant"):
            continue
        content = (h.get("content") or "").strip()[:1200]
        if content:
            messages.append({"role": role, "content": content})
    if mode == "simple":
        messages.append({"role": "user", "content": question.strip()})
    else:
        from app.wikirag_context_budget import chars_for_tokens, prompt_token_budget

        # Classic RAG (Desktop/RAG/script.py): один блок «Контекст».
        default_cap = int(getattr(settings, "wiki_rag_classic_context_chars", None) or 24_000)
        max_data = data_char_budget or max(default_cap, chars_for_tokens(prompt_token_budget() // 2))
        max_data = max(4_000, min(max_data, 48_000))
        parts: list[str] = []
        corax = (corax_block or "").strip()
        ctx = (documents_block or "").strip()
        if corax:
            parts.append(corax)
        if ctx:
            parts.append(ctx)
        joined = "\n\n".join(parts).strip()
        if len(joined) > max_data:
            joined = joined[: max_data - 20].rstrip() + "\n… [обрезано]"
        if not joined:
            joined = "(контекст пуст — в индексе ничего не найдено)"
        user_body = (
            "Сначала опирайся на контекст ниже. "
            "Если прямого ответа в базе знаний нет — напиши об этом явно, "
            "затем рассуждай по имеющимся данным и отдели факты от выводов. "
            "Не выдумывай конкретные hostname/IP/серийники, которых нет в контексте.\n\n"
            f"Контекст:\n{joined}"
            f"{_rag_user_suffix(question, focus)}"
        )
        messages.append({"role": "user", "content": user_body})
    return messages


def messages_stats(messages: list[dict[str, str]]) -> dict[str, Any]:
    total = sum(len(m.get("content") or "") for m in messages)
    return {
        "total_chars": total,
        "message_count": len(messages),
        "roles": [m.get("role") for m in messages],
    }


def _unescape_json_string(s: str) -> str:
    return (
        s.replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\t", "\t")
        .replace('\\"', '"')
        .replace("\\\\", "\\")
    )


def parse_assistant_json(raw: str) -> dict[str, Any] | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def extract_answer_text(raw: str) -> str:
    """Текст для UI: plain text как есть; JSON — только если есть непустой answer."""
    text = _sanitize_model_output((raw or "").strip())
    if not text:
        return ""

    parsed = parse_assistant_json(text)
    if parsed:
        ans = parsed.get("answer")
        if isinstance(ans, str) and ans.strip():
            return _sanitize_model_output(ans.strip())
        # JSON без полезного answer — показываем исходник, не выбрасываем
        if not (text.startswith("{") and text.endswith("}")):
            return text

    if '"answer"' in text or "'answer'" in text:
        for pat in (
            r'"answer"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"(?:confidence|sources|follow_up|suggested_actions)"',
            r'"answer"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}\s*$',
            r"'answer'\s*:\s*'((?:\\.|[^'\\])*)'\s*,\s*'(?:confidence|sources)",
        ):
            m = re.search(pat, text, re.DOTALL | re.IGNORECASE)
            if m:
                got = _unescape_json_string(m.group(1).strip())
                if got and not got.startswith("{"):
                    return _sanitize_model_output(got)

        m = re.search(r'"answer"\s*:\s*"(.*)', text, re.DOTALL | re.IGNORECASE)
        if m:
            tail = m.group(1)
            tail = re.split(r'"\s*,\s*"(?:confidence|sources|follow_up|suggested_actions)"', tail, maxsplit=1)[0]
            tail = re.sub(r'"\s*\}\s*$', "", tail).strip()
            got = _unescape_json_string(tail)
            if got:
                return _sanitize_model_output(got)

    return text


def _message_text_from_lm(msg: dict[str, Any]) -> str:
    """Текст ответа: content без think/reasoning-мусора; reasoning — только если content пуст."""
    if not isinstance(msg, dict):
        return ""
    main_parts: list[str] = []
    content = msg.get("content")
    if isinstance(content, str) and content.strip():
        main_parts.append(content.strip())
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                t = block.get("text") or block.get("content")
                if isinstance(t, str) and t.strip():
                    main_parts.append(t.strip())
    if main_parts:
        merged = _sanitize_model_output("\n".join(main_parts))
        if merged:
            return merged

    for key in ("reasoning_content", "reasoning"):
        v = msg.get(key)
        if isinstance(v, str) and v.strip():
            cleaned = _sanitize_model_output(v.strip())
            if cleaned and not _looks_like_reasoning_dump(cleaned):
                return cleaned
            # Truncated English CoT often still ends with a Russian draft — salvage it.
            extracted = _extract_russian_answer(v.strip())
            if extracted and not is_bad_lm_answer(extracted):
                return extracted
    return ""


def _has_reasoning_only(msg: dict[str, Any]) -> bool:
    """True if LM filled reasoning_* but left content empty (typical for thinking models)."""
    if not isinstance(msg, dict):
        return False
    content = msg.get("content")
    if isinstance(content, str) and content.strip():
        return False
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                t = block.get("text") or block.get("content")
                if isinstance(t, str) and t.strip():
                    return False
    for key in ("reasoning_content", "reasoning"):
        v = msg.get(key)
        if isinstance(v, str) and v.strip():
            return True
    return False


_EMPTY_LENGTH_HINT = (
    "\n\n[Служебно: ответь сразу по-русски финальным текстом. "
    "Без thinking process, без плана, без английских рассуждений.]"
)


def _append_no_think_hint(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    out = [dict(m) for m in messages]
    for i in range(len(out) - 1, -1, -1):
        if out[i].get("role") == "user":
            body = (out[i].get("content") or "").rstrip()
            if _EMPTY_LENGTH_HINT.strip() not in body:
                out[i]["content"] = body + _EMPTY_LENGTH_HINT
            break
    return out


def coerce_parsed(raw: str) -> dict[str, Any]:
    answer = extract_answer_text(raw)
    if not answer:
        answer = _sanitize_model_output((raw or "").strip())
    if not answer or is_bad_lm_answer(answer):
        answer = ""
    if not answer:
        answer = "Модель не вернула текст. Попробуйте короче вопрос или отключите «Подмешивать CORAX» в настройках чата."
    parsed = parse_assistant_json(raw) or {}
    sources = parsed.get("sources") if isinstance(parsed.get("sources"), list) else []
    return {
        "answer": answer,
        "confidence": parsed.get("confidence") or "medium",
        "sources": sources,
        "follow_up_questions": parsed.get("follow_up_questions") or [],
        "suggested_actions": parsed.get("suggested_actions") or [],
        "_plain_text": not bool(parse_assistant_json(raw)),
    }


def normalize_assistant_for_history(content: str) -> str:
    c = (content or "").strip()
    if not c:
        return c
    if c.startswith("{") and ("answer" in c or '"answer"' in c):
        return extract_answer_text(c)[:1500]
    return c[:1500]


def _messages_without_system_role(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    """
    Фолбэк для моделей/шаблонов LM Studio, где разрешены только user/assistant.
    Переносим system-инструкцию в начало первого user-сообщения.
    """
    if not messages:
        return messages
    system_parts: list[str] = []
    out: list[dict[str, str]] = []
    for m in messages:
        role = (m.get("role") or "").strip()
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            system_parts.append(content)
            continue
        if role in ("user", "assistant"):
            out.append({"role": role, "content": content})
    if system_parts:
        preface = "Инструкция:\n" + "\n\n".join(system_parts).strip()
        if out and out[0].get("role") == "user":
            out[0]["content"] = f"{preface}\n\n{out[0]['content']}"
        else:
            out.insert(0, {"role": "user", "content": preface})
    return out


async def _fetch_model_ids(client: httpx.AsyncClient, base: str) -> list[str]:
    res = await client.get(f"{base}/models")
    if res.status_code != 200:
        return []
    data = res.json()
    models = data.get("data") if isinstance(data, dict) else data
    ids: list[str] = []
    if isinstance(models, list):
        for m in models:
            if isinstance(m, dict) and m.get("id"):
                ids.append(str(m["id"]))
    return ids


def _pick_model(configured: str, available: list[str], preferred: str | None = None) -> str | None:
    pref = (preferred or "").strip()
    if pref and available:
        for mid in available:
            if mid == pref or pref in mid or mid.endswith(pref.split("/")[-1]):
                return mid
    cfg = (configured or "").strip()
    if not available:
        return pref or cfg or None
    if len(available) == 1:
        return available[0]
    if cfg:
        for mid in available:
            if mid == cfg or cfg in mid or mid.endswith(cfg.split("/")[-1]):
                return mid
    for mid in available:
        if "gemma" in mid.lower():
            return mid
    return available[0]


async def lm_studio_chat(
    messages: list[dict[str, str]],
    *,
    base_url: str | None = None,
    model: str | None = None,
    mode: ChatMode = "rag",
    response_mode: str = "fast",
) -> tuple[str, str | None]:
    from app.wikirag_context_budget import (
        human_lm_studio_error,
        is_context_overflow_error,
        parse_lm_error_body,
    )

    base = _base_url(base_url)
    provider = detect_llm_provider(base)
    label = llm_provider_label(provider)
    read_timeout = float(settings.lm_studio_timeout_seconds or 300)
    configured = (settings.lm_studio_model or "").strip()
    preferred = (model or "").strip() or None
    last_len = len((messages[-1].get("content") or "")) if messages else 0
    max_tokens = completion_max_tokens(mode=mode, response_mode=response_mode, last_user_chars=last_len)

    attempt_messages = [dict(m) for m in messages]
    last_detail = ""
    role_fallback_applied = False
    length_retry_done = False
    _MAX_OUT_TOKENS = 4096

    async with _lm_client(read=read_timeout) as client:
        # Не спрашиваем /models на каждом сообщении: это отдельный round-trip
        # в критическом пути и большинство OpenAI-compatible серверов принимают
        # явно заданную модель без предварительного discovery.
        picked_model = preferred or configured or None

        url = f"{base}/chat/completions"
        for attempt in range(4):
            payload: dict[str, Any] = {
                "messages": attempt_messages,
                "temperature": 0.25 if mode == "rag" else 0.3,
                "max_tokens": max_tokens,
                "stream": False,
            }
            if provider == "ollama":
                payload["options"] = _ollama_options(max_tokens=max_tokens, mode=mode)
            if picked_model:
                payload["model"] = picked_model

            try:
                res = await client.post(url, json=payload)
            except httpx.ReadTimeout as e:
                hint = (
                    "Увеличьте num_predict / timeout в Ollama или упростите вопрос."
                    if provider == "ollama"
                    else "Увеличьте Server Timeout в LM Studio."
                )
                raise RuntimeError(f"{label} не ответил за {int(read_timeout)} с. {hint}") from e

            if res.status_code == 200:
                data = res.json()
                choices = data.get("choices") or []
                if not choices:
                    raise RuntimeError(f"{label} вернул пустой ответ")
                choice0 = choices[0] if isinstance(choices[0], dict) else {}
                msg = choice0.get("message") or {}
                if not isinstance(msg, dict):
                    msg = {}
                content = _message_text_from_lm(msg)
                if content:
                    used_model = data.get("model") or picked_model
                    return content, used_model

                fr = str(choice0.get("finish_reason") or data.get("finish_reason") or "").lower()
                # Thinking-модель исчерпала бюджет на reasoning → content пустой.
                # Повторяем с большим max_tokens и явной просьбой без CoT.
                if (
                    not length_retry_done
                    and attempt < 3
                    and (fr in ("length", "max_tokens") or _has_reasoning_only(msg))
                ):
                    length_retry_done = True
                    max_tokens = min(_MAX_OUT_TOKENS, max(max_tokens * 2, 3072))
                    continue
                raise RuntimeError(
                    f"{label} вернул пустой текст (finish_reason={fr!r}). "
                    "Попробуйте модель без reasoning или увеличьте LM_STUDIO_MAX_TOKENS."
                )

            body_text = res.text
            try:
                body_json = res.json()
            except Exception:
                body_json = None
            last_detail = parse_lm_error_body(body_text, body_json)
            if is_context_overflow_error(last_detail) and attempt < 3:
                attempt_messages = shrink_messages(attempt_messages)
                max_tokens = max(256, int(max_tokens * 0.8))
                continue
            if (
                "only user and assistant roles are supported" in (last_detail or "").lower()
                and not role_fallback_applied
                and attempt < 3
            ):
                attempt_messages = _messages_without_system_role(attempt_messages)
                role_fallback_applied = True
                continue
            if _CHANNEL_ERR_RE.search(last_detail or "") and attempt < 3:
                # Часто на локальных моделях это перегруз контекста/памяти:
                # ужимаем контекст и выход, затем пробуем ещё раз.
                attempt_messages = shrink_messages(attempt_messages)
                max_tokens = max(256, int(max_tokens * 0.7))
                continue
            if res.status_code == 504:
                raise RuntimeError(human_lm_studio_error(504, last_detail, provider=provider))
            raise RuntimeError(human_lm_studio_error(res.status_code, last_detail, provider=provider))

    raise RuntimeError(
        human_lm_studio_error(0, last_detail or "неизвестная ошибка", provider=provider)
    )


async def lm_studio_chat_stream(
    messages: list[dict[str, str]],
    *,
    base_url: str | None = None,
    model: str | None = None,
    mode: ChatMode = "rag",
    response_mode: str = "fast",
) -> AsyncIterator[tuple[str, str | None]]:
    """Стримит текстовые delta OpenAI-compatible chat completion.

    Модель выбирается без /models, чтобы первый токен не ждал лишний запрос.
    Повторная отправка запроса во время уже начатого стрима недопустима:
    она может продублировать ответ, поэтому ошибки передаются вызывающему коду.
    """
    base = _base_url(base_url)
    provider = detect_llm_provider(base)
    label = llm_provider_label(provider)
    read_timeout = float(settings.lm_studio_timeout_seconds or 300)
    configured = (settings.lm_studio_model or "").strip()
    picked_model = (model or "").strip() or configured or None
    last_len = len((messages[-1].get("content") or "")) if messages else 0
    max_tokens = completion_max_tokens(mode=mode, response_mode=response_mode, last_user_chars=last_len)

    payload: dict[str, Any] = {
        "messages": messages,
        "temperature": 0.25 if mode == "rag" else 0.3,
        "max_tokens": max_tokens,
        "stream": True,
    }
    if provider == "ollama":
        # Без num_ctx Ollama часто сидит на 4096, а CORAX шлёт большой RAG — ответ превращается в кашу.
        payload["options"] = _ollama_options(max_tokens=max_tokens, mode=mode)
    if picked_model:
        payload["model"] = picked_model

    async with _lm_client(read=read_timeout) as client:
        try:
            async with client.stream("POST", f"{base}/chat/completions", json=payload) as res:
                if res.status_code != 200:
                    detail = await res.aread()
                    raise RuntimeError(f"{label}: HTTP {res.status_code}: {detail.decode(errors='replace')[:500]}")
                used_model = picked_model
                async for line in res.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        event = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(event, dict) and event.get("model"):
                        used_model = str(event["model"])
                    choices = event.get("choices") if isinstance(event, dict) else None
                    if not isinstance(choices, list) or not choices:
                        continue
                    choice = choices[0] if isinstance(choices[0], dict) else {}
                    delta = choice.get("delta") or {}
                    if not isinstance(delta, dict):
                        continue
                    pieces: list[str] = []
                    # Do not stream reasoning_* — thinking models dump English CoT for minutes
                    # and the UI shows gibberish before the real answer.
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        pieces.append(content)
                    elif isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict):
                                t = block.get("text") or block.get("content")
                                if isinstance(t, str) and t:
                                    pieces.append(t)
                    for piece in pieces:
                        yield piece, used_model
        except httpx.ReadTimeout as e:
            raise RuntimeError(f"{label} не передал данные за {int(read_timeout)} с.") from e


async def lm_studio_health(*, base_url: str | None = None, preferred_model: str | None = None) -> dict[str, Any]:
    try:
        base = _base_url(base_url)
    except ValueError as e:
        return {"ok": False, "detail": str(e), "proxy_bypass": True, "base_url": base_url}
    provider = detect_llm_provider(base)
    label = llm_provider_label(provider)
    configured = (settings.lm_studio_model or "").strip()
    try:
        async with _lm_client(read=30.0) as client:
            res = await client.get(f"{base}/models")
            if res.status_code == 200:
                ids = await _fetch_model_ids(client, base)
                picked = _pick_model(configured, ids, preferred_model)
                return {
                    "ok": True,
                    "models": ids[:20],
                    "selected_model": picked,
                    "base_url": base,
                    "provider": provider,
                    "detail": f"Модель: {picked}" if picked else f"{label} доступен",
                    "proxy_bypass": True,
                }
            if res.status_code == 504:
                picked = preferred_model or configured or None
                return {
                    "ok": True,
                    "models": [picked] if picked else [],
                    "selected_model": picked,
                    "base_url": base,
                    "provider": provider,
                    "detail": (
                        f"Сервер отвечает (504 на /models). Модель должна быть загружена в {label}."
                    ),
                    "proxy_bypass": True,
                }
            return {
                "ok": False,
                "detail": f"HTTP {res.status_code}",
                "proxy_bypass": True,
                "base_url": base,
                "provider": provider,
            }
    except httpx.ConnectError:
        if provider == "ollama":
            hint = "Запустите Ollama (`ollama serve`) и `ollama pull <модель>`, порт 11434."
        elif provider == "lm_studio":
            hint = "LM Studio → Start Server, порт 1234."
        else:
            hint = "Проверьте, что OpenAI-совместимый сервер запущен и URL оканчивается на /v1."
        return {
            "ok": False,
            "detail": f"Нет соединения с {base}. {hint}",
            "proxy_bypass": True,
            "base_url": base,
            "provider": provider,
        }
    except httpx.ReadTimeout:
        picked = preferred_model or configured or None
        return {
            "ok": True,
            "models": [picked] if picked else [],
            "selected_model": picked,
            "base_url": base,
            "provider": provider,
            "detail": "Медленный ответ /models — попробуйте отправить сообщение",
            "proxy_bypass": True,
        }
    except Exception as e:
        return {
            "ok": False,
            "detail": str(e),
            "proxy_bypass": True,
            "base_url": base,
            "provider": provider,
        }
