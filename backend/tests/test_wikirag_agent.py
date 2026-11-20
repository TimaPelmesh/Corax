"""Unit tests for WikiRAG agent tools schema, dispatch, and loop fallback."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from app.wikirag_agent import (
    build_agent_seed_messages,
    execute_wikirag_tool,
    resolve_agent_system_prompt,
    run_wikirag_agent_loop,
    wikirag_tool_schemas,
)
from app.wikirag_lm import LmChatResult


def test_tool_schemas_cover_vector_and_inventory():
    names = {t["function"]["name"] for t in wikirag_tool_schemas()}
    assert "search_wiki" in names
    assert "search_computers" in names
    assert "search_tickets" in names
    assert "search_printers" in names
    assert "get_computer" in names
    assert "get_network_device" in names
    assert "query_corax" in names


def test_seed_messages_advertise_tools_flow():
    msgs = build_agent_seed_messages("какие ПК на Win10", [])
    assert msgs[0]["role"] == "system"
    assert "search_computers" in msgs[0]["content"]
    assert "get_computer" in msgs[0]["content"]
    assert msgs[-1]["role"] == "user"
    assert "Win10" in msgs[-1]["content"]
    assert "search_computers" in msgs[-1]["content"].lower() or "query_corax" in msgs[-1]["content"].lower()


def test_resolve_agent_system_keeps_tools_when_custom():
    out = resolve_agent_system_prompt("Отвечай кратко.")
    assert "search_computers" in out
    assert "Отвечай кратко" in out


@pytest.mark.asyncio
async def test_execute_search_computers_passes_filters():
    captured: dict[str, Any] = {}

    async def fake_search(db, question, *, filters=None, limit=None):
        captured["question"] = question
        captured["filters"] = filters
        captured["limit"] = limit
        return "### tool:search_computers\nok", []

    with patch("app.wikirag_agent.tool_search_computers", new=fake_search):
        text, _ = await execute_wikirag_tool(
            "search_computers",
            {"query": "win10 low ram", "os": "10", "ram_lt": 8, "software": "Chrome", "limit": 12},
            db=AsyncMock(),
            documents=[],
            question="fallback",
        )
    assert "search_computers" in text
    assert captured["filters"]["os"] == "10"
    assert captured["filters"]["ram_lt"] == 8
    assert captured["filters"]["software"] == "Chrome"
    assert captured["limit"] == 12


@pytest.mark.asyncio
async def test_agent_loop_uses_tool_calls_then_answers():
    calls = {"n": 0}

    class Pack:
        context = "### tool:search_computers\nseed"
        tools_used = ["search_computers"]
        sources = []

    async def fake_raw(messages, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return LmChatResult(
                content="",
                model="test",
                tool_calls=[
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "search_computers", "arguments": "{}"},
                        "name": "search_computers",
                        "arguments": {"os": "10", "limit": 5},
                    }
                ],
                finish_reason="tool_calls",
                raw_message={},
            )
        return LmChatResult(
            content="Вывод: 3 ПК на Windows 10.",
            model="test",
            tool_calls=[],
            finish_reason="stop",
            raw_message={},
        )

    async def fake_exec(name, args, **kwargs):
        return "### tool:search_computers\nПод фильтр: 3. Показано: 3.", []

    with (
        patch("app.wikirag_agent.lm_studio_chat_raw", new=fake_raw),
        patch("app.wikirag_agent.execute_wikirag_tool", new=fake_exec),
        patch("app.wikirag_agent._fallback_tool_pack", new=AsyncMock(return_value=Pack())),
    ):
        result = await run_wikirag_agent_loop(
            db=AsyncMock(),
            question="какие ПК на Win10",
            documents=[],
            include_corax=True,
        )
    assert "Windows 10" in result.content or "Вывод" in result.content
    assert "search_computers" in result.tools_used
    assert result.rounds >= 1


@pytest.mark.asyncio
async def test_agent_loop_seeds_tools_and_retries_refusal():
    calls = {"n": 0}

    async def fake_raw(messages, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return LmChatResult(
                content="В контексте нет информации.",
                model="test",
                tool_calls=[],
                finish_reason="stop",
                raw_message={},
            )
        return LmChatResult(
            content="Вывод: в парке 2 слабых ПК.",
            model="test",
            tool_calls=[],
            finish_reason="stop",
            raw_message={},
        )

    class Pack:
        context = "### tool:search_computers\nВсего: 2"
        tools_used = ["search_computers"]
        sources = []

    with (
        patch("app.wikirag_agent.lm_studio_chat_raw", new=fake_raw),
        patch("app.wikirag_agent._fallback_tool_pack", new=AsyncMock(return_value=Pack())),
    ):
        result = await run_wikirag_agent_loop(
            db=AsyncMock(),
            question="какие ПК слабые",
            documents=[],
            include_corax=True,
        )
    assert "seed" in result.tools_used or "search_computers" in result.tools_used
    assert result.path in {"agent+seed", "agent+retry"}
    assert "слабых" in result.content.lower() or "Вывод" in result.content


@pytest.mark.asyncio
async def test_execute_search_printers():
    async def fake_printers(db, question, *, toner_lt=None, limit=None):
        assert toner_lt == 5
        return "### tool:search_printers\ntoner=2%", []

    with patch("app.wikirag_agent.tool_search_printers", new=fake_printers):
        text, _ = await execute_wikirag_tool(
            "search_printers",
            {"query": "без тонера", "toner_lt": 5},
            db=AsyncMock(),
            documents=[],
            question="fallback",
        )
    assert "search_printers" in text
