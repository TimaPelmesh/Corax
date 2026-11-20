"""WikiRAG agent loop: OpenAI tools → execute → second pass with tool results.

Local 3B models often skip tool_calls — then we run compact deterministic tools
once and still do a final completion so the model sees structured results.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import WikiRagDocument
from app.wikirag_lm import (
    WIKIRAG_SYSTEM_RAG,
    LmChatResult,
    classify_wikirag_question,
    is_weak_or_truncated_answer,
    lm_studio_chat_raw,
    retrieval_question,
)
from app.wikirag_tools import (
    RagSource,
    ToolPack,
    needs_live_inventory_tools,
    run_wikirag_tools,
    tool_get_computer,
    tool_get_network_device,
    tool_query_corax,
    tool_search_computers,
    tool_search_printers,
    tool_search_tickets,
    tool_search_wiki,
)

_REFUSAL_RE = re.compile(
    r"(в\s+контексте\s+нет|нет\s+информац|не\s+найден[оа]?|не\s+могу\s+найт|"
    r"данных\s+нет|информаци[яи]\s+отсутств)",
    re.IGNORECASE,
)

ProgressCb = Callable[[dict[str, Any]], Awaitable[None] | None]

_MAX_TOOL_ROUNDS = 3

WIKIRAG_AGENT_SYSTEM = """Ты аналитик парка CORAX. Отвечаешь по-русски. Поведение детерминированное.

Инструменты (используй узко — не забивай контекст всем парком):
- search_computers — фильтр ПК (os, ram_lt/gt/eq, software, limit). Для «сколько / у кого / список».
- search_printers — принтеры и тонер (toner_lt). Для «без тонера / мало тонера / список принтеров».
- get_computer — один/несколько hostname или id. Для «карточка ПК X».
- query_corax — краткая статистика/сводка (ОС, ПО, заявки, принтеры), без полного списка.
- search_tickets — заявки по статусу/тексту.
- get_network_device — IP / hostname / sysName сетевого устройства.
- search_wiki — векторный поиск по документам WikiRAG (регламенты, заметки). Не дублируй им живой инвентарь.

Правила выбора тулов:
1) Конкретный ПК/IP → get_computer или get_network_device (не search_* на весь парк).
2) Принтеры / тонер / картридж → search_printers (обязательно), не отказывайся без вызова.
3) Фильтр/статистика парка → search_computers или query_corax с фильтрами; limit ≤ 15.
4) Документы/регламент → search_wiki с коротким query; top_k ≤ 8.
5) Никогда не проси «весь парк» и не повторяй один тул без новых аргументов.
6) Факты (hostname, IP, версии, тонер %, количества) — только из результатов тулов. Не выдумывай.
7) «В контексте нет» — только если тулы реально вернули пусто. Если в tool:search_printers есть строки — отвечай по ним.
8) Ответ: сначала вывод (1–2 предложения), затем 2–5 строк фактов. Без воды.
"""


def resolve_agent_system_prompt(custom: str | None = None) -> str:
    """Agent tool rules always win; operator custom text is appended, never replaces tools."""
    base = WIKIRAG_AGENT_SYSTEM.strip()
    extra = (custom or "").strip()
    if not extra or extra == base:
        return base
    # Avoid duplicating the default RAG prompt if someone saved it as custom.
    if "Hostname, IP, версии" in extra and "Контекст" in extra and len(extra) < 900:
        return base
    return f"{base}\n\nДоп. инструкции оператора:\n{extra[:4000]}"


def wikirag_tool_schemas() -> list[dict[str, Any]]:
    """OpenAI-compatible tools list for chat/completions."""
    return [
        {
            "type": "function",
            "function": {
                "name": "search_wiki",
                "description": "Семантический поиск по WikiRAG (векторная БД чанков документов).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Поисковый запрос"},
                        "top_k": {"type": "integer", "description": "Число чанков (1–15)", "default": 8},
                        "max_chars": {
                            "type": "integer",
                            "description": "Потолок символов результата",
                            "default": 6000,
                        },
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_computers",
                "description": (
                    "Фильтрованная выборка ПК из живого инвентаря CORAX. "
                    "Для больших парков возвращает агрегаты + компактный список, не все 500 карточек."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Вопрос / уточнение фильтра"},
                        "os": {
                            "type": "string",
                            "description": "Фильтр ОС: 10 | 11 | windows | linux",
                        },
                        "ram_lt": {"type": "number", "description": "RAM меньше N ГБ"},
                        "ram_gt": {"type": "number", "description": "RAM больше N ГБ"},
                        "ram_eq": {"type": "number", "description": "RAM около N ГБ"},
                        "software": {"type": "string", "description": "Имя ПО для фильтра"},
                        "limit": {"type": "integer", "description": "Сколько ПК показать (1–40)", "default": 15},
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_tickets",
                "description": "Выборка заявок с фильтрами по статусу/тексту.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_printers",
                "description": (
                    "Живой список принтеров CORAX с уровнем тонера. "
                    "Для «без тонера / мало тонера / какие принтеры» — вызывай этот тул."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Вопрос / уточнение"},
                        "toner_lt": {
                            "type": "integer",
                            "description": "Тонер меньше или равен N % (без тонера ≈ 5, мало ≈ 15)",
                        },
                        "limit": {"type": "integer", "description": "Сколько показать (1–60)", "default": 25},
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_computer",
                "description": "Карточка ПК по hostname или id.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "hostnames": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Список hostname или numeric id",
                        },
                    },
                    "required": ["hostnames"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "get_network_device",
                "description": "Сетевое устройство по IP / hostname / sysName.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "needles": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["needles"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "query_corax",
                "description": "Краткая сводка живого снимка CORAX по фокусу вопроса (ОС/ПО/заявки/сеть).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                    },
                    "required": [],
                },
            },
        },
    ]


@dataclass
class AgentResult:
    content: str
    model: str | None = None
    tools_used: list[str] = field(default_factory=list)
    sources: list[dict[str, Any]] = field(default_factory=list)
    rounds: int = 0
    path: str = "agent"
    stats: dict[str, Any] = field(default_factory=dict)


async def execute_wikirag_tool(
    name: str,
    args: dict[str, Any],
    *,
    db: AsyncSession,
    documents: list[WikiRagDocument],
    question: str,
    include_corax: bool = True,
) -> tuple[str, list[RagSource]]:
    """Dispatch one tool call to existing tool_* implementations."""
    q = str(args.get("query") or question or "").strip() or question
    n = (name or "").strip()

    if n == "search_wiki":
        return await tool_search_wiki(
            db,
            q,
            documents,
            top_k=int(args.get("top_k") or 8),
            max_chars=int(args.get("max_chars") or 6000),
        )

    if not include_corax and n != "search_wiki":
        return "### tool:denied\nCORAX отключён в настройках чата.", []

    if n == "search_computers":
        explicit = {
            k: args[k]
            for k in ("os", "ram_lt", "ram_gt", "ram_eq", "software", "terms")
            if args.get(k) is not None and args.get(k) != ""
        }
        return await tool_search_computers(
            db,
            q,
            filters=explicit or None,
            limit=int(args["limit"]) if args.get("limit") is not None else None,
        )
    if n == "search_tickets":
        return await tool_search_tickets(db, q)
    if n == "search_printers":
        return await tool_search_printers(
            db,
            q,
            toner_lt=int(args["toner_lt"]) if args.get("toner_lt") is not None else None,
            limit=int(args["limit"]) if args.get("limit") is not None else None,
        )
    if n == "get_computer":
        hosts = args.get("hostnames") or args.get("hostname") or []
        if isinstance(hosts, str):
            hosts = [hosts]
        return await tool_get_computer(db, [str(h) for h in hosts][:12])
    if n == "get_network_device":
        needles = args.get("needles") or args.get("ips") or []
        if isinstance(needles, str):
            needles = [needles]
        return await tool_get_network_device(db, [str(x) for x in needles][:16])
    if n == "query_corax":
        return await tool_query_corax(db, q)
    return f"### tool:unknown\nНеизвестный инструмент: {n}", []


def _assistant_tool_message(result: LmChatResult) -> dict[str, Any]:
    msg: dict[str, Any] = {
        "role": "assistant",
        "content": result.content or None,
    }
    if result.tool_calls:
        msg["tool_calls"] = [
            {
                "id": tc["id"],
                "type": "function",
                "function": {
                    "name": tc["name"],
                    "arguments": json.dumps(tc.get("arguments") or {}, ensure_ascii=False),
                },
            }
            for tc in result.tool_calls
        ]
    return msg


def _tool_result_message(call_id: str, name: str, content: str) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": call_id,
        "name": name,
        "content": content or "(пусто)",
    }


def build_agent_seed_messages(
    question: str,
    history: list[dict[str, str]],
    *,
    system_prompt: str | None = None,
) -> list[dict[str, Any]]:
    system = resolve_agent_system_prompt(system_prompt)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for h in (history or [])[-4:]:
        role = h.get("role") or "user"
        if role not in ("user", "assistant"):
            continue
        content = (h.get("content") or "").strip()[:1200]
        if content:
            messages.append({"role": role, "content": content})
    focus = classify_wikirag_question(question)
    tool_hint = {
        "os_hardware": "Предпочти: query_corax и/или search_computers с os/ram фильтрами.",
        "software": "Предпочти: search_computers(software=…) или query_corax; не тащи весь парк.",
        "tickets": "Предпочти: search_tickets, при необходимости query_corax.",
        "network": "Предпочти: get_network_device или query_corax focus=network.",
        "printers": "Обязательно: search_printers (toner_lt=5 для «без тонера», 15 для «мало»).",
        "general": "Выбери минимальный набор тулов под вопрос.",
    }.get(focus, "Выбери минимальный набор тулов под вопрос.")
    messages.append(
        {
            "role": "user",
            "content": (
                f"Вопрос: {question.strip()}\n\n"
                f"{tool_hint}\n"
                "Сначала тулы с узкими фильтрами, затем ответ: вывод → краткий расчёт. "
                "Не отвечай «в контексте нет», пока не вызвал нужный тул."
            ),
        }
    )
    return messages


async def _fallback_tool_pack(
    db: AsyncSession,
    question: str,
    *,
    documents: list[WikiRagDocument],
    include_corax: bool,
) -> ToolPack:
    return await run_wikirag_tools(
        db,
        question,
        wiki_documents=documents,
        include_corax=include_corax,
    )


def _inject_pack_as_tool(
    messages: list[dict[str, Any]],
    pack: ToolPack,
    *,
    call_id: str = "seed_pack",
    tool_name: str = "query_corax",
) -> None:
    messages.append(
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": tool_name, "arguments": "{}"},
                }
            ],
        }
    )
    messages.append(_tool_result_message(call_id, tool_name, pack.context or "(пусто)"))


def _looks_like_refusal(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if _REFUSAL_RE.search(t):
        return True
    return is_weak_or_truncated_answer(t)


def _effective_question(question: str, history: list[dict[str, str]] | None) -> str:
    """Nudge «пойди поищи» → исходный вопрос из истории + nudge."""
    return retrieval_question(question, history) or (question or "").strip()


async def run_wikirag_agent_loop(
    *,
    db: AsyncSession,
    question: str,
    documents: list[WikiRagDocument],
    history: list[dict[str, str]] | None = None,
    include_corax: bool = True,
    base_url: str | None = None,
    model: str | None = None,
    response_mode: str = "fast",
    system_prompt: str | None = None,
    on_progress: ProgressCb | None = None,
) -> AgentResult:
    """Tool-first agent: seed live tools, then model; extra tools / refusal retry."""
    raw_q = (question or "").strip()
    q = _effective_question(raw_q, history)
    focus = classify_wikirag_question(q)
    messages = build_agent_seed_messages(q, history or [], system_prompt=system_prompt)
    tools = wikirag_tool_schemas()
    used: list[str] = []
    sources: list[RagSource] = []
    rounds = 0
    last_model: str | None = None
    path = "agent"
    seeded = False

    async def _prog(payload: dict[str, Any]) -> None:
        if on_progress is None:
            return
        maybe = on_progress(payload)
        if maybe is not None and hasattr(maybe, "__await__"):
            await maybe  # type: ignore[misc]

    # Deterministic seed: inventory/printer questions always get live tool data first.
    if (include_corax and needs_live_inventory_tools(q, focus)) or (
        bool(documents) and focus in {"general", "printers"}
    ):
        await _prog({"stage": "tool", "label": "Тулы (сервер)…", "tool": "seed"})
        pack = await _fallback_tool_pack(db, q, documents=documents, include_corax=include_corax)
        if pack.context:
            _inject_pack_as_tool(
                messages,
                pack,
                call_id="seed_pack",
                tool_name=(pack.tools_used[0] if pack.tools_used else "query_corax"),
            )
            used.extend(pack.tools_used)
            used.append("seed")
            sources.extend(pack.sources)
            seeded = True
            path = "agent+seed"

    for round_i in range(_MAX_TOOL_ROUNDS):
        rounds = round_i + 1
        await _prog({"stage": "think", "label": f"Агент · раунд {rounds}…", "round": rounds})
        # After seed, first pass answers or asks more tools; later rounds keep tools.
        result = await lm_studio_chat_raw(
            messages,
            base_url=base_url,
            model=model,
            mode="rag",
            response_mode=response_mode,
            tools=tools,
            tool_choice="auto",
        )
        last_model = result.model or last_model

        if result.tool_calls:
            messages.append(_assistant_tool_message(result))
            for tc in result.tool_calls:
                name = tc["name"]
                args = tc.get("arguments") or {}
                await _prog({"stage": "tool", "label": f"Тул: {name}", "tool": name})
                text, srcs = await execute_wikirag_tool(
                    name,
                    args if isinstance(args, dict) else {},
                    db=db,
                    documents=documents,
                    question=q,
                    include_corax=include_corax,
                )
                used.append(name)
                sources.extend(srcs)
                messages.append(_tool_result_message(tc["id"], name, text))
            continue

        content = (result.content or "").strip()
        # Refusal / empty after seed → one forced re-search then final answer.
        if _looks_like_refusal(content) and seeded and "refusal_retry" not in used:
            path = "agent+retry"
            await _prog({"stage": "tool", "label": "Повторный поиск…", "tool": "retry"})
            pack = await _fallback_tool_pack(db, q, documents=documents, include_corax=include_corax)
            _inject_pack_as_tool(messages, pack, call_id="refusal_retry", tool_name="search_wiki")
            used.extend(pack.tools_used)
            used.append("refusal_retry")
            sources.extend(pack.sources)
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Выше — результаты тулов. Ответь по ним конкретно. "
                        "Не пиши «в контексте нет», если в блоках tool: есть строки данных."
                    ),
                }
            )
            final = await lm_studio_chat_raw(
                messages,
                base_url=base_url,
                model=model,
                mode="rag",
                response_mode=response_mode,
                tools=None,
            )
            return AgentResult(
                content=final.content,
                model=final.model or last_model,
                tools_used=list(dict.fromkeys(used)),
                sources=[s.to_dict() for s in sources][:24],
                rounds=rounds + 1,
                path=path,
                stats={"focus": focus, "retry": True},
            )

        # No tools and no refusal — done.
        if content:
            return AgentResult(
                content=content,
                model=last_model,
                tools_used=list(dict.fromkeys(used)),
                sources=[s.to_dict() for s in sources][:24],
                rounds=rounds,
                path=path,
                stats={"focus": focus, "seeded": seeded},
            )

        # Empty content without tools — fall through if not yet seeded.
        if not seeded and (
            (include_corax and needs_live_inventory_tools(q, focus)) or bool(documents)
        ):
            path = "agent+fallback"
            await _prog({"stage": "tool", "label": "Тулы (сервер)…", "tool": "fallback"})
            pack = await _fallback_tool_pack(db, q, documents=documents, include_corax=include_corax)
            _inject_pack_as_tool(messages, pack, call_id="fallback_pack")
            used.extend(pack.tools_used)
            used.append("fallback")
            sources.extend(pack.sources)
            seeded = True
            continue
        break

    await _prog({"stage": "generate", "label": "Финальный ответ…"})
    messages.append(
        {
            "role": "user",
            "content": "Достаточно данных. Дай финальный ответ по результатам тулов.",
        }
    )
    final = await lm_studio_chat_raw(
        messages,
        base_url=base_url,
        model=model,
        mode="rag",
        response_mode=response_mode,
        tools=None,
    )
    return AgentResult(
        content=final.content,
        model=final.model or last_model,
        tools_used=list(dict.fromkeys(used)),
        sources=[s.to_dict() for s in sources][:24],
        rounds=rounds,
        path=path,
        stats={"focus": focus, "seeded": seeded},
    )


async def iter_wikirag_agent_stream(
    *,
    db: AsyncSession,
    question: str,
    documents: list[WikiRagDocument],
    history: list[dict[str, str]] | None = None,
    include_corax: bool = True,
    base_url: str | None = None,
    model: str | None = None,
    response_mode: str = "fast",
    system_prompt: str | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any] | None]]:
    """Yield progress/delta/done. Tools run non-stream; answer is streamed."""
    progress_events: list[dict[str, Any]] = []

    async def _on_progress(payload: dict[str, Any]) -> None:
        progress_events.append(payload)

    try:
        # Drain progress collected during the sync-ish tool loop via callback,
        # then stream the final answer text for the UI typewriter.
        # We run the full agent first so seed/retry logic stays in one place.
        for ev in progress_events:
            yield ("progress", ev)

        # Emit early progress before the blocking loop.
        yield ("progress", {"stage": "think", "label": "Агент · готовит тулы…", "round": 0})

        result = await run_wikirag_agent_loop(
            db=db,
            question=question,
            documents=documents,
            history=history,
            include_corax=include_corax,
            base_url=base_url,
            model=model,
            response_mode=response_mode,
            system_prompt=system_prompt,
            on_progress=_on_progress,
        )
        for ev in progress_events:
            yield ("progress", ev)

        content = (result.content or "").strip()
        # Refusal after tools — last-chance rewrite from packed context is already in loop.
        if content:
            # Stream in chunks so the UI typewriter still animates.
            step = max(24, len(content) // 40)
            for i in range(0, len(content), step):
                yield ("delta", {"text": content[i : i + step], "model": result.model})
        yield (
            "done",
            {
                "content": content,
                "model": result.model,
                "tools_used": result.tools_used,
                "sources": result.sources,
                "rounds": result.rounds,
                "path": result.path,
                "focus": (result.stats or {}).get("focus"),
            },
        )
    except Exception as e:
        yield ("error", {"error": str(e)})


def _messages_for_final_completion(
    messages: list[dict[str, Any]],
    *,
    question: str,
) -> list[dict[str, str]]:
    """Flatten tool results into a classic Контекст block for stream-safe completion."""
    system = resolve_agent_system_prompt(None)
    tool_blocks: list[str] = []
    hist: list[dict[str, str]] = []
    for m in messages:
        role = m.get("role")
        if role == "system":
            system = str(m.get("content") or system)
        elif role == "tool":
            body = str(m.get("content") or "").strip()
            if body:
                tool_blocks.append(body)
        elif role in ("user", "assistant"):
            # Skip synthetic tool_calls-only assistant turns.
            if m.get("tool_calls") and not (m.get("content") or "").strip():
                continue
            content = str(m.get("content") or "").strip()
            if content:
                hist.append({"role": role, "content": content[:1200]})

    ctx = "\n\n".join(tool_blocks).strip() or "(результаты тулов пусты)"
    if len(ctx) > 14000:
        ctx = ctx[:13980].rstrip() + "\n… [обрезано]"
    out: list[dict[str, str]] = [{"role": "system", "content": system or WIKIRAG_SYSTEM_RAG}]
    # Keep at most last user/assistant pair before the tool turn.
    for h in hist[-3:]:
        if h["role"] == "user" and h["content"].startswith("Вопрос:"):
            continue
        out.append(h)
    out.append(
        {
            "role": "user",
            "content": (
                "Факты бери из контекста. Сначала вывод, затем краткий расчёт.\n\n"
                f"Контекст:\n{ctx}\n\nВопрос: {question.strip()}\n\nОтвет:"
            ),
        }
    )
    return out
