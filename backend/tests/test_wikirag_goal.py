"""Goal-loop: build_goal, critique, planner, scratchpad, and streamed trace."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from app.wikirag_goal import (
    AgentObservation,
    build_goal,
    build_scratchpad_messages,
    critique_enough,
    decide_next_action,
    run_goal_agent_loop,
)
from app.wikirag_lm import LmChatResult


def test_build_goal_printers_low_toner():
    goal = build_goal("какие принтеры без тонера", focus="printers")
    assert goal.focus == "printers"
    assert "тонер" in goal.text.lower() or "принтер" in goal.text.lower()
    assert any("≤5%" in c or "5%" in c or "пуст" in c for c in goal.criteria)


def test_build_goal_os_hardware():
    goal = build_goal("какие ПК на Windows 10 с RAM меньше 8", focus="os_hardware")
    assert goal.focus == "os_hardware"
    assert "hostname" in " ".join(goal.criteria).lower() or "ОС" in " ".join(goal.criteria)


def test_critique_enough_true_for_search_printers():
    goal = build_goal("принтеры с низким тонером", focus="printers")
    obs = [
        AgentObservation(
            tool="search_printers",
            summary="search_printers: 3 строк",
            facts="### tool:search_printers\n- HP-01 toner=2%\n- HP-02 toner=4%",
            useful=True,
        )
    ]
    ok, msg = critique_enough(goal, obs)
    assert ok is True
    assert "принтер" in msg.lower()


def test_critique_enough_false_when_empty():
    goal = build_goal("принтеры", focus="printers")
    ok, _ = critique_enough(goal, [])
    assert ok is False
    empty = AgentObservation(
        tool="search_printers",
        summary="пусто",
        facts="### tool:search_printers\n(пусто)",
        useful=False,
    )
    ok2, _ = critique_enough(goal, [empty])
    assert ok2 is False


def test_decide_next_action_printers_then_stop():
    goal = build_goal("принтеры без тонера", focus="printers")
    first = decide_next_action(goal, [], [], iteration=1)
    assert first is not None
    assert first.tool == "search_printers"
    assert first.args.get("toner_lt") == 5

    obs = [
        AgentObservation(
            tool="search_printers",
            summary="ok",
            facts="- HP toner=1%",
            useful=True,
        )
    ]
    nxt = decide_next_action(goal, obs, ["search_printers"], iteration=2)
    assert nxt is None


def test_scratchpad_contains_goal_observe_facts():
    goal = build_goal("список принтеров", focus="printers")
    obs = [
        AgentObservation(
            tool="search_printers",
            summary="search_printers: 1 строк",
            facts="### tool:search_printers\n- OFFICE-HP toner=3%",
            useful=True,
        )
    ]
    msgs = build_scratchpad_messages(goal, obs)
    user = msgs[-1]["content"]
    assert "Цель:" in user
    assert "Уже сделано:" in user
    assert "Факты:" in user
    assert "OFFICE-HP" in user
    assert "Вопрос:" in user


@pytest.mark.asyncio
async def test_goal_loop_emits_trace_and_retries_refusal():
    steps: list[dict[str, Any]] = []
    calls = {"n": 0}

    async def on_step(payload: dict[str, Any]) -> None:
        steps.append(payload)

    async def fake_exec(name, args, **kwargs):
        assert name == "search_printers"
        return (
            "### tool:search_printers\nПод фильтр: 2. Показано: 2.\n- P1 toner=2%\n- P2 toner=4%",
            [],
        )

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
            content="Вывод: P1 и P2 почти без тонера.",
            model="test",
            tool_calls=[],
            finish_reason="stop",
            raw_message={},
        )

    with (
        patch("app.wikirag_goal._execute_tool", new=fake_exec),
        patch("app.wikirag_goal.lm_studio_chat_raw", new=fake_raw),
        patch("app.wikirag_goal.classify_wikirag_question", return_value="printers"),
    ):
        result = await run_goal_agent_loop(
            db=AsyncMock(),
            question="какие принтеры без тонера",
            documents=[],
            include_corax=True,
            on_step=on_step,
        )

    assert result.path == "goal"
    assert "search_printers" in result.tools_used
    assert len(result.trace) >= 3
    kinds = [s["kind"] for s in result.trace]
    assert "goal" in kinds
    assert "tool" in kinds
    assert "observe" in kinds
    assert "critique" in kinds
    assert "answer" in kinds
    assert len(steps) >= 3
    assert "P1" in result.content or "тонер" in result.content.lower()
    assert calls["n"] >= 2
