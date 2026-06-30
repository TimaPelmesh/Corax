from __future__ import annotations

import json
import re
from typing import Any, Literal

import httpx

from app.config import settings

ChatMode = Literal["simple", "rag"]

WIKIRAG_SYSTEM_RAG = """Ты ассистент WikiRAG (база знаний CORAX). Отвечай на русском обычным текстом (2–8 предложений).
Опирайся на блок «Документы» и вопрос пользователя. Если в документах нет ответа — честно скажи.
Не используй JSON, markdown-таблицы и не повторяй дословно предыдущий ответ — отвечай по новому вопросу."""

WIKIRAG_SYSTEM_SIMPLE = (
    "Ты помощник WikiRAG в CORAX. Отвечай кратко по-русски обычным текстом (1–3 предложения). "
    "Без JSON. Документы не прикладываются."
)


def _base_url() -> str:
    return (settings.lm_studio_base_url or "http://127.0.0.1:1234/v1").rstrip("/")


def _lm_client(*, read: float) -> httpx.AsyncClient:
    # Важно: не использовать системный прокси (trust_env=False), иначе localhost → 504.
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=15.0, read=read, write=30.0, pool=15.0),
        trust_env=False,
    )


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


def build_messages(
    question: str,
    documents_block: str,
    history: list[dict[str, str]],
    *,
    mode: ChatMode = "rag",
) -> list[dict[str, str]]:
    system = WIKIRAG_SYSTEM_SIMPLE if mode == "simple" else WIKIRAG_SYSTEM_RAG
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
        ctx = (documents_block or "").strip()
        max_ctx = int(getattr(settings, "wiki_rag_chat_context_max_chars", None) or 4_000)
        if len(ctx) > max_ctx:
            ctx = ctx[:max_ctx] + "\n… [обрезано]"
        user_body = f"Документы:\n{ctx or '(в базе пока нет текстовых документов)'}\n\nВопрос: {question.strip()}"
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
    """Текст для UI и истории: убирает обёртку JSON (в т.ч. с битыми кавычками внутри answer)."""
    text = (raw or "").strip()
    if not text:
        return "(пустой ответ)"

    parsed = parse_assistant_json(text)
    if parsed:
        ans = parsed.get("answer")
        if isinstance(ans, str) and ans.strip():
            return ans.strip()

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
                    return got

        # Битый JSON: всё между "answer":" и хвостом , "confidence" / }
        m = re.search(r'"answer"\s*:\s*"(.*)', text, re.DOTALL | re.IGNORECASE)
        if m:
            tail = m.group(1)
            tail = re.split(r'"\s*,\s*"(?:confidence|sources|follow_up|suggested_actions)"', tail, maxsplit=1)[0]
            tail = re.sub(r'"\s*\}\s*$', "", tail).strip()
            got = _unescape_json_string(tail)
            if got:
                return got

    if text.startswith("{") and text.endswith("}"):
        # Не показывать сырой JSON в чате
        inner = re.sub(r'^\{\s*"answer"\s*:\s*"?', "", text, flags=re.IGNORECASE).rstrip("}")
        inner = re.sub(r'"\s*,\s*"(?:confidence|sources)[\s\S]*$', "", inner, flags=re.IGNORECASE)
        inner = inner.strip().strip('"')
        if inner:
            return inner

    return text


def coerce_parsed(raw: str) -> dict[str, Any]:
    answer = extract_answer_text(raw)
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


def _pick_model(configured: str, available: list[str]) -> str | None:
    cfg = (configured or "").strip()
    if not available:
        return cfg or None
    if cfg:
        for mid in available:
            if mid == cfg or cfg in mid or mid.endswith(cfg.split("/")[-1]):
                return mid
    for mid in available:
        if "gemma" in mid.lower():
            return mid
    return available[0]


async def lm_studio_chat(messages: list[dict[str, str]]) -> tuple[str, str | None]:
    base = _base_url()
    read_timeout = float(settings.lm_studio_timeout_seconds or 300)
    configured = (settings.lm_studio_model or "").strip()
    max_tokens = int(settings.lm_studio_max_tokens or 512)
    # Для коротких диалогов — меньше токенов, быстрее ответ.
    if messages and len(messages[-1].get("content", "")) < 80:
        max_tokens = min(max_tokens, 256)

    async with _lm_client(read=read_timeout) as client:
        available: list[str] = []
        try:
            available = await _fetch_model_ids(client, base)
        except httpx.HTTPError:
            pass
        model = _pick_model(configured, available)

        payload: dict[str, Any] = {
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if model:
            payload["model"] = model

        url = f"{base}/chat/completions"
        try:
            res = await client.post(url, json=payload)
        except httpx.ReadTimeout as e:
            raise RuntimeError(
                f"LM Studio не ответил за {int(read_timeout)} с. Увеличьте Server Timeout в LM Studio."
            ) from e

        if res.status_code == 504:
            raise RuntimeError(
                "LM Studio: таймаут 504. Частые причины: (1) прокси — мы отключаем trust_env; "
                "(2) модель не загружена в RAM; (3) слишком длинный промпт. "
                "Для «привет» используется короткий режим без документов."
            )
        res.raise_for_status()
        data = res.json()

    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("LM Studio вернул пустой ответ")
    msg = choices[0].get("message") or {}
    content = (msg.get("content") or "").strip()
    used_model = data.get("model") or model
    return content, used_model


async def lm_studio_health() -> dict[str, Any]:
    base = _base_url()
    configured = (settings.lm_studio_model or "").strip()
    try:
        async with _lm_client(read=30.0) as client:
            res = await client.get(f"{base}/models")
            if res.status_code == 200:
                ids = await _fetch_model_ids(client, base)
                picked = _pick_model(configured, ids)
                return {
                    "ok": True,
                    "models": ids[:20],
                    "detail": f"Модель: {picked}" if picked else "Сервер доступен",
                    "proxy_bypass": True,
                }
            if res.status_code == 504:
                return {
                    "ok": True,
                    "models": [configured] if configured else [],
                    "detail": "Сервер отвечает (504 на /models). Модель должна быть загружена в LM Studio.",
                    "proxy_bypass": True,
                }
            return {"ok": False, "detail": f"HTTP {res.status_code}", "proxy_bypass": True}
    except httpx.ConnectError:
        return {
            "ok": False,
            "detail": f"Нет соединения с {base}. LM Studio → Start Server, порт 1234.",
            "proxy_bypass": True,
        }
    except httpx.ReadTimeout:
        return {
            "ok": True,
            "models": [configured] if configured else [],
            "detail": "Медленный ответ /models — попробуйте отправить сообщение",
            "proxy_bypass": True,
        }
    except Exception as e:
        return {"ok": False, "detail": str(e), "proxy_bypass": True}
