from __future__ import annotations

import json
import re
from typing import Any, Literal

import httpx

from app.config import settings

ChatMode = Literal["simple", "rag"]
QuestionFocus = Literal["os_hardware", "software", "tickets", "general"]

WIKIRAG_SYSTEM_RAG = """Ты — ассистент CORAX по инвентаризации парка ПК и обслуживанию.

Тебе передают снимок базы CORAX (CSV-таблицы) и загруженные документы WikiRAG.
Используй их вместе: анализируй строки, сравнивай ПК, делай обоснованные выводы.

Правила ответа:
- Пиши по-русски развёрнуто: краткий вывод, затем детали или список с hostname.
- У каждого ПК есть computer_id и hostname — называй hostname в рекомендациях.
- На вопросы «кому лучше», «кого обновить», «кому ставить Windows» отвечай анализом полей
  os_name, os_version, ram_gb, cpu, tags, location, ПО и заявок — это нормальный ответ по данным.
- Допускается экспертное суждение (минимум RAM для Win10, приоритет старых ОС), если оно
  согласуется с таблицами; явно отмечай допущения.
- «В данных CORAX этого нет» — только если в таблицах нет ни одного поля по теме вопроса
  (пароли, секреты, данные вне инвентаризации). Не используй эту фразу для рекомендаций по ОС.
- Не выводи JSON, не пиши только «answer», не оборачивай ответ в служебные скобки.
- ЗАПРЕЩЕНО: thinking process, chain-of-thought, план ответа, рассуждения на английском.
  Данные CSV уже переданы в сообщении пользователя — используй их. Сразу пиши финальный ответ на русском."""

WIKIRAG_OS_GUIDANCE = """
Ориентиры для рекомендаций по ОС (если в организации нет иной политики):
- Windows 10: рекомендуется ≥4 ГБ RAM, комфортно 8+ ГБ; ПК на Windows 7/8 — кандидаты на миграцию.
- Уже Windows 10/11 — мажорное обновление ОС обычно не требуется.
- При RAM ≤4 ГБ или слабом CPU — укажи риск или апгрейд железа перед Win10.
"""

WIKIRAG_SYSTEM_SIMPLE = (
    "Ты помощник CORAX. Отвечай кратко по-русски обычным текстом. Без JSON."
)

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
    if "no data is provided" in low or "no actual data" in low or "данных нет" in low and len(t) < 120:
        return True
    if len(t) < 80 and _cyrillic_char_ratio(t) < 0.1:
        return True
    return False


def normalize_lm_base_url(raw: str | None) -> str:
    base = (raw or settings.lm_studio_base_url or "http://127.0.0.1:1234/v1").strip()
    if not base:
        base = "http://127.0.0.1:1234/v1"
    if not re.match(r"^https?://", base, re.IGNORECASE):
        raise ValueError("URL LM Studio должен начинаться с http:// или https://")
    base = base.rstrip("/")
    if not base.lower().endswith("/v1"):
        base = f"{base}/v1"
    return base.rstrip("/")


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
            "установ",
            "upgrade",
            "желез",
            "ram",
            "озу",
            "процессор",
            "cpu",
            "мощност",
            "слаб",
            "кому лучше",
            "кого обнов",
        )
    ):
        return "os_hardware"
    if any(k in low for k in ("програм", " софт", "1с", "установлен", "по на", "какое по")):
        return "software"
    if any(k in low for k in ("заявк", "тикет", "обращен", "инцидент")):
        return "tickets"
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

    out: list[dict[str, str]] = []
    for u, a in pairs[-3:]:
        out.append(u)
        out.append(a)
    return out


def _rag_user_suffix(question: str, focus: QuestionFocus) -> str:
    q = question.strip()
    if focus == "os_hardware":
        return (
            f"\n\nВопрос: {q}\n\n"
            "Таблицы CSV с данными уже в этом сообщении выше — не пиши, что данных нет.\n"
            "Проанализируй os_name, os_version, ram_gb, cpu, tags. "
            "Сразу дай финальный ответ на русском: кому ставить Windows 10, "
            "список hostname по группам с обоснованием. Без плана и рассуждений на английском."
        )
    return (
        f"\n\nВопрос: {q}\n\n"
        "Проанализируй данные и документы, сделай выводы. Ответь развёрнуто текстом на русском."
    )


def build_messages(
    question: str,
    documents_block: str,
    history: list[dict[str, str]],
    *,
    corax_block: str = "",
    mode: ChatMode = "rag",
    data_char_budget: int | None = None,
    question_focus: QuestionFocus | None = None,
) -> list[dict[str, str]]:
    focus = question_focus or classify_wikirag_question(question)
    system = WIKIRAG_SYSTEM_SIMPLE if mode == "simple" else WIKIRAG_SYSTEM_RAG
    if mode == "rag" and focus == "os_hardware":
        system = system + WIKIRAG_OS_GUIDANCE
    messages: list[dict[str, str]] = [{"role": "system", "content": system}]
    hist = [] if mode == "simple" else sanitize_chat_history(history)
    for h in hist:
        role = h.get("role") or "user"
        if role not in ("user", "assistant"):
            continue
        content = (h.get("content") or "").strip()[:1500]
        if content:
            messages.append({"role": role, "content": content})
    if mode == "simple":
        messages.append({"role": "user", "content": question.strip()})
    else:
        from app.wikirag_context_budget import chars_for_tokens, prompt_token_budget

        max_data = data_char_budget or chars_for_tokens(prompt_token_budget() // 2)
        corax = (corax_block or "").strip()
        corax_cap = int(max_data * (0.68 if focus == "os_hardware" else 0.5))
        if len(corax) > corax_cap:
            corax = corax[: max(0, corax_cap - 20)].rstrip() + "\n… [обрезано]"
        ctx = (documents_block or "").strip()
        docs_budget = max(500, max_data - len(corax) - 80)
        if len(ctx) > docs_budget:
            ctx = ctx[: docs_budget - 20].rstrip() + "\n… [обрезано]"
        parts: list[str] = []
        if corax:
            parts.append(
                "Данные CORAX (таблицы CSV, связь по computer_id и hostname):\n" + corax
            )
        parts.append(
            "Загруженные документы (файлы базы знаний; CSV — табличные, смотри заголовки колонок):\n"
            + (ctx or "(в базе пока нет текстовых документов)")
        )
        user_body = "\n\n".join(parts) + _rag_user_suffix(question, focus)
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
            r'"answer"\s*:\s*"(.+?)"\s*,\s*"(?:confidence|sources|follow_up|suggested_actions)"',
            r'"answer"\s*:\s*"(.+)"\s*\}\s*$',
            r"'answer'\s*:\s*'(.+?)'\s*,\s*'(?:confidence|sources)",
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
    return ""


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
) -> tuple[str, str | None]:
    from app.wikirag_context_budget import (
        human_lm_studio_error,
        is_context_overflow_error,
        parse_lm_error_body,
        shrink_messages,
    )

    base = _base_url(base_url)
    read_timeout = float(settings.lm_studio_timeout_seconds or 300)
    configured = (settings.lm_studio_model or "").strip()
    preferred = (model or "").strip() or None
    max_tokens = int(settings.lm_studio_max_tokens or 768)
    last_len = len((messages[-1].get("content") or "")) if messages else 0
    if mode == "simple" and last_len < 80:
        max_tokens = min(max_tokens, 256)
    elif mode == "rag" or last_len > 800:
        max_tokens = max(max_tokens, 1024)

    attempt_messages = [dict(m) for m in messages]
    last_detail = ""

    async with _lm_client(read=read_timeout) as client:
        available: list[str] = []
        try:
            available = await _fetch_model_ids(client, base)
        except httpx.HTTPError:
            pass
        picked_model = _pick_model(configured, available, preferred)

        url = f"{base}/chat/completions"
        for attempt in range(3):
            payload: dict[str, Any] = {
                "messages": attempt_messages,
                "temperature": 0.35 if mode == "rag" else 0.3,
                "max_tokens": max_tokens,
                "stream": False,
            }
            if mode == "rag":
                payload["chat_template_kwargs"] = {"enable_thinking": False}
            if picked_model:
                payload["model"] = picked_model

            try:
                res = await client.post(url, json=payload)
            except httpx.ReadTimeout as e:
                raise RuntimeError(
                    f"LM Studio не ответил за {int(read_timeout)} с. Увеличьте Server Timeout в LM Studio."
                ) from e

            if res.status_code == 200:
                data = res.json()
                choices = data.get("choices") or []
                if not choices:
                    raise RuntimeError("LM Studio вернул пустой ответ")
                choice0 = choices[0] if isinstance(choices[0], dict) else {}
                msg = choice0.get("message") or {}
                content = _message_text_from_lm(msg)
                if not content:
                    fr = choice0.get("finish_reason") or data.get("finish_reason")
                    raise RuntimeError(
                        f"LM Studio вернул пустой текст (finish_reason={fr!r}). "
                        "Попробуйте модель без reasoning или увеличьте max tokens."
                    )
                used_model = data.get("model") or picked_model
                return content, used_model

            body_text = res.text
            try:
                body_json = res.json()
            except Exception:
                body_json = None
            last_detail = parse_lm_error_body(body_text, body_json)
            if is_context_overflow_error(last_detail) and attempt < 2:
                attempt_messages = shrink_messages(attempt_messages)
                continue
            if res.status_code == 504:
                raise RuntimeError(human_lm_studio_error(504, last_detail))
            raise RuntimeError(human_lm_studio_error(res.status_code, last_detail))

    raise RuntimeError(human_lm_studio_error(0, last_detail or "неизвестная ошибка"))


async def lm_studio_health(*, base_url: str | None = None, preferred_model: str | None = None) -> dict[str, Any]:
    try:
        base = _base_url(base_url)
    except ValueError as e:
        return {"ok": False, "detail": str(e), "proxy_bypass": True, "base_url": base_url}
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
                    "detail": f"Модель: {picked}" if picked else "Сервер доступен",
                    "proxy_bypass": True,
                }
            if res.status_code == 504:
                picked = preferred_model or configured or None
                return {
                    "ok": True,
                    "models": [picked] if picked else [],
                    "selected_model": picked,
                    "base_url": base,
                    "detail": "Сервер отвечает (504 на /models). Модель должна быть загружена в LM Studio.",
                    "proxy_bypass": True,
                }
            return {"ok": False, "detail": f"HTTP {res.status_code}", "proxy_bypass": True, "base_url": base}
    except httpx.ConnectError:
        return {
            "ok": False,
            "detail": f"Нет соединения с {base}. LM Studio → Start Server, порт 1234.",
            "proxy_bypass": True,
            "base_url": base,
        }
    except httpx.ReadTimeout:
        picked = preferred_model or configured or None
        return {
            "ok": True,
            "models": [picked] if picked else [],
            "selected_model": picked,
            "base_url": base,
            "detail": "Медленный ответ /models — попробуйте отправить сообщение",
            "proxy_bypass": True,
        }
    except Exception as e:
        return {"ok": False, "detail": str(e), "proxy_bypass": True, "base_url": base}
