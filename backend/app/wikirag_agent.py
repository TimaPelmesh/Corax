"""WikiRAG agent loop: OpenAI tools → execute → second pass with tool results.

Local 3B models often skip tool_calls — then we run compact deterministic tools
once and still do a final completion so the model sees structured results.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable, Awaitable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import WikiRagDocument
from app.wikirag_lm import (
    WIKIRAG_SYSTEM_RAG,
    LmChatResult,
    classify_wikirag_question,
    lm_studio_chat_raw,
    lm_studio_chat_stream,
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
    tool_search_tickets,
    tool_search_wiki,
)

ProgressCb = Callable[[dict[str, Any]], Awaitable[None] | None]

_MAX_TOOL_ROUNDS = 3

WIKIRAG_AGENT_SYSTEM = """Ты аналитик парка CORAX. Отвечаешь по-русски.
У тебя есть инструменты: search_wiki (векторная БД документов), search_computers,
search_tickets, get_computer, get_network_device, query_corax.
Правила:
- Сначала вызови нужные тулы с фильтрами (os, ram_lt, software). Не проси весь парк.
- Hostname, IP, версии и количества бери только из результатов тулов. Не выдумывай.
- После тулов дай структурированный ответ: сначала вывод, затем 2–5 строк расчёта.
- Если данных мало — уточни фильтр, а не отказывайся.
"""


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
    system = (system_prompt or "").strip() or WIKIRAG_AGENT_SYSTEM
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for h in (history or [])[-4:]:
        role = h.get("role") or "user"
        if role not in ("user", "assistant"):
            continue
        content = (h.get("content") or "").strip()[:1200]
        if content:
            messages.append({"role": role, "content": content})
    messages.append(
        {
            "role": "user",
            "content": (
                f"Вопрос: {question.strip()}\n\n"
                "Если нужны факты из базы — вызови тулы с узкими фильтрами, "
                "затем дай ответ: сначала вывод, потом краткий расчёт."
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
    """Multi-round tools loop with deterministic fallback when the model skips tools."""
    q = (question or "").strip()
    focus = classify_wikirag_question(q)
    messages = build_agent_seed_messages(q, history or [], system_prompt=system_prompt)
    tools = wikirag_tool_schemas()
    used: list[str] = []
    sources: list[RagSource] = []
    rounds = 0
    last_model: str | None = None
    path = "agent"

    async def _prog(payload: dict[str, Any]) -> None:
        if on_progress is None:
            return
        maybe = on_progress(payload)
        if maybe is not None and hasattr(maybe, "__await__"):
            await maybe  # type: ignore[misc]

    for round_i in range(_MAX_TOOL_ROUNDS):
        rounds = round_i + 1
        await _prog({"stage": "think", "label": f"Агент · раунд {rounds}…", "round": rounds})
        result = await lm_studio_chat_raw(
            messages,
            base_url=base_url,
            model=model,
            mode="rag",
            response_mode=response_mode,
            tools=tools if round_i < _MAX_TOOL_ROUNDS else None,
            tool_choice="auto" if round_i < _MAX_TOOL_ROUNDS else None,
        )
        last_model = result.model or last_model

        if not result.tool_calls:
            if round_i == 0 and (
                (include_corax and needs_live_inventory_tools(q, focus)) or bool(documents)
            ):
                # Weak local models skip tools — inject compact server-side pack once.
                path = "agent+fallback"
                await _prog({"stage": "tool", "label": "Тулы (сервер)…", "tool": "fallback"})
                pack = await _fallback_tool_pack(
                    db, q, documents=documents, include_corax=include_corax
                )
                used.extend(pack.tools_used)
                sources.extend(pack.sources)
                messages.append(
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "fallback_pack",
                                "type": "function",
                                "function": {
                                    "name": "query_corax",
                                    "arguments": "{}",
                                },
                            }
                        ],
                    }
                )
                messages.append(
                    _tool_result_message(
                        "fallback_pack",
                        "query_corax",
                        pack.context or "(пусто)",
                    )
                )
                used.append("fallback")
                # Final answer without further tools.
                await _prog({"stage": "generate", "label": "Собирает ответ…"})
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
                    stats={"focus": focus, "fallback": True},
                )
            return AgentResult(
                content=result.content,
                model=last_model,
                tools_used=list(dict.fromkeys(used)),
                sources=[s.to_dict() for s in sources][:24],
                rounds=rounds,
                path=path,
                stats={"focus": focus},
            )

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

    # Cap reached — force final answer.
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
        stats={"focus": focus, "capped": True},
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
    """Yield ('progress'|'delta'|'done'|'error', payload) for SSE wiring.

    Tool rounds are non-stream; only the final answer is streamed.
    """
    q = (question or "").strip()
    focus = classify_wikirag_question(q)
    messages = build_agent_seed_messages(q, history or [], system_prompt=system_prompt)
    tools = wikirag_tool_schemas()
    used: list[str] = []
    sources: list[RagSource] = []
    rounds = 0
    last_model: str | None = None
    path = "agent"
    fallback_done = False

    try:
        for round_i in range(_MAX_TOOL_ROUNDS):
            rounds = round_i + 1
            yield (
                "progress",
                {"stage": "think", "label": f"Агент · раунд {rounds}…", "round": rounds},
            )
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

            if not result.tool_calls:
                if (
                    round_i == 0
                    and not fallback_done
                    and ((include_corax and needs_live_inventory_tools(q, focus)) or bool(documents))
                ):
                    fallback_done = True
                    path = "agent+fallback"
                    yield (
                        "progress",
                        {"stage": "tool", "label": "Тулы (сервер)…", "tool": "fallback"},
                    )
                    pack = await _fallback_tool_pack(
                        db, q, documents=documents, include_corax=include_corax
                    )
                    used.extend(pack.tools_used)
                    sources.extend(pack.sources)
                    used.append("fallback")
                    messages.append(
                        {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "fallback_pack",
                                    "type": "function",
                                    "function": {"name": "query_corax", "arguments": "{}"},
                                }
                            ],
                        }
                    )
                    messages.append(
                        _tool_result_message(
                            "fallback_pack",
                            "query_corax",
                            pack.context or "(пусто)",
                        )
                    )
                    break
                # Model answered without tools on a later round — stream that text.
                if result.content:
                    yield ("delta", {"text": result.content, "model": last_model})
                    yield (
                        "done",
                        {
                            "content": result.content,
                            "model": last_model,
                            "tools_used": list(dict.fromkeys(used)),
                            "sources": [s.to_dict() for s in sources][:24],
                            "rounds": rounds,
                            "path": path,
                        },
                    )
                    return
                break

            messages.append(_assistant_tool_message(result))
            for tc in result.tool_calls:
                name = tc["name"]
                args = tc.get("arguments") or {}
                yield ("progress", {"stage": "tool", "label": f"Тул: {name}", "tool": name})
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
        else:
            messages.append(
                {
                    "role": "user",
                    "content": "Достаточно данных. Дай финальный ответ по результатам тулов.",
                }
            )

        yield ("progress", {"stage": "generate", "label": "Собирает ответ…"})
        # Final pass is non-stream: many local servers reject role=tool in SSE.
        # We still emit one delta so the Ask UI typewriter path works.
        final_messages = _messages_for_final_completion(messages, question=q)
        content = ""
        try:
            async for delta, used_model, stats in lm_studio_chat_stream(
                final_messages,
                base_url=base_url,
                model=model,
                mode="rag",
                response_mode=response_mode,
                question=q,
            ):
                if used_model:
                    last_model = used_model
                if stats and not delta:
                    yield ("meta_llm", stats)
                    continue
                if not delta:
                    continue
                content += delta
                yield ("delta", {"text": delta, "model": last_model})
        except Exception:
            content = ""

        if not content.strip():
            final = await lm_studio_chat_raw(
                final_messages,
                base_url=base_url,
                model=model,
                mode="rag",
                response_mode=response_mode,
                tools=None,
            )
            content = final.content or ""
            last_model = final.model or last_model
            if content:
                yield ("delta", {"text": content, "model": last_model})

        yield (
            "done",
            {
                "content": content,
                "model": last_model,
                "tools_used": list(dict.fromkeys(used)),
                "sources": [s.to_dict() for s in sources][:24],
                "rounds": rounds,
                "path": path,
                "focus": focus,
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
    system = WIKIRAG_AGENT_SYSTEM
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
