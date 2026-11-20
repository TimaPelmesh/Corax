"""Goal-driven ReAct orchestrator for WikiRAG Ask.

Server owns plan/critique so 3B models still finish investigative answers.
Structured AgentStep events are emitted for the UI trace (not raw CoT).
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import WikiRagDocument
from app.wikirag_lm import (
    QuestionFocus,
    classify_wikirag_question,
    is_weak_or_truncated_answer,
    lm_studio_chat_raw,
    retrieval_question,
)
from app.wikirag_tools import RagSource, needs_live_inventory_tools

StepKind = Literal["goal", "plan", "tool", "observe", "critique", "answer"]
StepStatus = Literal["running", "done", "failed"]

_MAX_ASK_ITERS = 5
_REFUSAL_RE = re.compile(
    r"(в\s+контексте\s+нет|нет\s+информац|не\s+найден[оа]?|не\s+могу\s+найт|"
    r"данных\s+нет|информаци[яи]\s+отсутств)",
    re.IGNORECASE,
)

StepCb = Callable[[dict[str, Any]], Awaitable[None] | None]


@dataclass
class AgentGoal:
    text: str
    criteria: list[str]
    focus: QuestionFocus
    question: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "criteria": list(self.criteria),
            "focus": self.focus,
            "question": self.question,
        }


@dataclass
class AgentStep:
    id: str
    kind: StepKind
    title: str
    detail: str = ""
    status: StepStatus = "done"
    iteration: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AgentObservation:
    tool: str
    summary: str
    facts: str
    useful: bool
    sources: list[RagSource] = field(default_factory=list)


@dataclass
class PlannedAction:
    tool: str
    args: dict[str, Any]
    title: str
    detail: str = ""


@dataclass
class GoalAgentResult:
    content: str
    model: str | None = None
    tools_used: list[str] = field(default_factory=list)
    sources: list[dict[str, Any]] = field(default_factory=list)
    rounds: int = 0
    path: str = "goal"
    goal: dict[str, Any] = field(default_factory=dict)
    trace: list[dict[str, Any]] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)


def build_goal(question: str, focus: QuestionFocus | None = None) -> AgentGoal:
    q = (question or "").strip()
    f = focus or classify_wikirag_question(q)
    low = q.lower()
    if f == "printers":
        if any(k in low for k in ("без тонер", "закончил", "пуст", "out of")):
            crit = ["список принтеров с тонером ≤5% или явно пустой выборкой"]
            text = "Найти принтеры без тонера (критически низкий уровень) и перечислить их."
        else:
            crit = ["список принтеров с уровнем тонера и итог по фильтру"]
            text = "Найти принтеры по вопросу (тонер/имя) и дать конкретный список."
    elif f == "os_hardware":
        crit = ["выборка ПК с ОС/RAM/hostname", "вывод с конкретными hostname"]
        text = "Собрать факты по железу/ОС парка и ответить сравнением или списком."
    elif f == "software":
        crit = ["совпадения ПО по ПК или явный ноль"]
        text = "Найти ПК с нужным ПО и перечислить hostname."
    elif f == "tickets":
        crit = ["выборка заявок со статусами"]
        text = "Найти релевантные заявки и кратко разобрать."
    elif f == "network":
        crit = ["сетевые устройства или IP из снимка"]
        text = "Найти сетевые устройства/шлюзы по вопросу."
    else:
        crit = ["факты из wiki или живого снимка CORAX", "конкретный вывод без отказа"]
        text = f"Разобрать вопрос по базе CORAX/WikiRAG: {q[:160]}"
    return AgentGoal(text=text, criteria=crit, focus=f, question=q)


def _obs_summary(tool: str, facts: str) -> tuple[str, bool]:
    body = (facts or "").strip()
    if not body or body.endswith("(пусто)") or "Совпадений нет" in body:
        return f"{tool}: пусто или без совпадений", False
    lines = [ln for ln in body.splitlines() if ln.strip().startswith("- ")]
    n = len(lines)
    head = next((ln for ln in body.splitlines() if "Под фильтр" in ln or "Всего" in ln), "")
    useful = n > 0 or ("Принтеров в снимке" in body) or ("ОС в парке" in body) or len(body) > 120
    if head:
        return f"{tool}: {head.strip()} · строк={n}", useful
    return f"{tool}: {n} строк фактов" if n else f"{tool}: {len(body)} симв.", useful


def critique_enough(goal: AgentGoal, observations: list[AgentObservation]) -> tuple[bool, str]:
    """Heuristic: enough useful tool facts to answer without another round."""
    if not observations:
        return False, "Ещё нет наблюдений — нужен тул."
    useful = [o for o in observations if o.useful]
    if not useful:
        return False, "Тулы пока пустые — уточню фильтр или другой источник."
    focus = goal.focus
    tools = {o.tool for o in useful}
    if focus == "printers" and "search_printers" in tools:
        return True, "Есть выборка принтеров — можно отвечать."
    if focus == "os_hardware" and ("search_computers" in tools or "query_corax" in tools):
        return True, "Есть выборка/сводка по ПК — можно отвечать."
    if focus == "software" and ("search_computers" in tools or "query_corax" in tools):
        return True, "Есть данные по ПО — можно отвечать."
    if focus == "tickets" and "search_tickets" in tools:
        return True, "Есть заявки — можно отвечать."
    if focus == "network" and ("get_network_device" in tools or "query_corax" in tools):
        return True, "Есть сетевые факты — можно отвечать."
    if "search_wiki" in tools and any(len(o.facts) > 200 for o in useful):
        return True, "Wiki дал достаточно контекста."
    if len(useful) >= 2:
        return True, "Несколько полезных наблюдений — закрываю цель."
    return False, "Данных мало — ещё один узкий тул."


def decide_next_action(
    goal: AgentGoal,
    observations: list[AgentObservation],
    used_tools: list[str],
    *,
    iteration: int,
) -> PlannedAction | None:
    """Rule-based planner. Returns None when we should answer."""
    enough, _ = critique_enough(goal, observations)
    if enough and observations:
        return None

    used = set(used_tools)
    focus = goal.focus
    q = goal.question

    def once(name: str, title: str, args: dict[str, Any] | None = None) -> PlannedAction | None:
        if name in used and iteration > 0:
            return None
        return PlannedAction(tool=name, args=args or {"query": q}, title=title, detail=name)

    if focus == "printers":
        if "search_printers" not in used:
            lt = 5 if any(k in q.lower() for k in ("без тонер", "пуст", "закончил")) else 15
            return PlannedAction(
                tool="search_printers",
                args={"query": q, "toner_lt": lt, "limit": 25},
                title=f"Ищу принтеры с тонером ≤{lt}%",
                detail=f"search_printers(toner_lt={lt})",
            )
        if "query_corax" not in used:
            return once("query_corax", "Сводка принтеров из снимка CORAX")
        if "search_wiki" not in used:
            return once("search_wiki", "Доп. поиск по WikiRAG (принтеры)")
        return None

    if focus == "os_hardware":
        if "query_corax" not in used:
            return once("query_corax", "Сводка парка (ОС / железо)")
        if "search_computers" not in used:
            return once("search_computers", "Фильтрованная выборка ПК")
        if "search_wiki" not in used and iteration >= 2:
            return once("search_wiki", "Доп. чанки WikiRAG")
        return None

    if focus == "software":
        if "search_computers" not in used:
            return once("search_computers", "ПК с нужным ПО")
        if "query_corax" not in used:
            return once("query_corax", "Сводка по ПО")
        return None

    if focus == "tickets":
        if "search_tickets" not in used:
            return once("search_tickets", "Выборка заявок")
        if "query_corax" not in used:
            return once("query_corax", "Итоги по заявкам")
        return None

    if focus == "network":
        if "query_corax" not in used:
            return once("query_corax", "Сетевой снимок")
        if "search_wiki" not in used:
            return once("search_wiki", "Wiki по сети")
        return None

    # general
    if needs_live_inventory_tools(q, focus) and "query_corax" not in used:
        return once("query_corax", "Живой снимок CORAX")
    if "search_wiki" not in used:
        return once("search_wiki", "Поиск по векторной базе WikiRAG")
    if "search_computers" not in used and iteration >= 1:
        return once("search_computers", "Выборка ПК на всякий случай")
    return None


def build_scratchpad_messages(
    goal: AgentGoal,
    observations: list[AgentObservation],
    *,
    system_prompt: str | None = None,
) -> list[dict[str, str]]:
    system = _resolve_system(system_prompt)
    done_lines = [f"- {o.summary}" for o in observations] or ["- (пока пусто)"]
    facts = "\n\n".join(o.facts for o in observations if o.facts).strip() or "(фактов нет)"
    if len(facts) > 12000:
        facts = facts[:11980].rstrip() + "\n… [обрезано]"
    criteria = "; ".join(goal.criteria)
    user = (
        f"Цель: {goal.text}\n"
        f"Критерий готовности: {criteria}\n\n"
        f"Уже сделано:\n" + "\n".join(done_lines) + "\n\n"
        f"Факты:\n{facts}\n\n"
        f"Вопрос: {goal.question}\n\n"
        "Ответь по фактам: сначала вывод (1–2 предложения), затем 2–5 строк с hostname/цифрами. "
        "Не пиши «в контексте нет», если в «Факты» есть строки данных."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _looks_like_refusal(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if _REFUSAL_RE.search(t):
        return True
    return is_weak_or_truncated_answer(t)


class _Trace:
    def __init__(self) -> None:
        self.steps: list[AgentStep] = []
        self._n = 0

    def add(
        self,
        kind: StepKind,
        title: str,
        *,
        detail: str = "",
        status: StepStatus = "done",
        iteration: int = 0,
    ) -> AgentStep:
        self._n += 1
        step = AgentStep(
            id=f"s{self._n}",
            kind=kind,
            title=title,
            detail=detail,
            status=status,
            iteration=iteration,
        )
        self.steps.append(step)
        return step

    def as_dicts(self) -> list[dict[str, Any]]:
        return [s.to_dict() for s in self.steps]


def _execute_tool(
    name: str,
    args: dict[str, Any],
    *,
    db: AsyncSession,
    documents: list[WikiRagDocument],
    question: str,
    include_corax: bool,
):
    from app.wikirag_agent import execute_wikirag_tool

    return execute_wikirag_tool(
        name,
        args,
        db=db,
        documents=documents,
        question=question,
        include_corax=include_corax,
    )


def _resolve_system(custom: str | None) -> str:
    from app.wikirag_agent import resolve_agent_system_prompt

    return resolve_agent_system_prompt(custom)


async def run_goal_agent_loop(
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
    on_step: StepCb | None = None,
    on_progress: StepCb | None = None,
    max_iters: int = _MAX_ASK_ITERS,
) -> GoalAgentResult:
    raw_q = (question or "").strip()
    q = retrieval_question(raw_q, history) or raw_q
    focus = classify_wikirag_question(q)
    goal = build_goal(q, focus)
    trace = _Trace()
    observations: list[AgentObservation] = []
    used: list[str] = []
    sources: list[RagSource] = []
    last_model: str | None = None

    async def _emit(step: AgentStep) -> None:
        payload = step.to_dict()
        if on_step:
            maybe = on_step(payload)
            if maybe is not None and hasattr(maybe, "__await__"):
                await maybe  # type: ignore[misc]
        if on_progress:
            maybe = on_progress(
                {
                    "stage": step.kind,
                    "label": step.title,
                    "detail": step.detail,
                    "iteration": step.iteration,
                }
            )
            if maybe is not None and hasattr(maybe, "__await__"):
                await maybe  # type: ignore[misc]

    gstep = trace.add("goal", goal.text, detail="; ".join(goal.criteria), iteration=0)
    await _emit(gstep)

    for iteration in range(1, max(1, max_iters) + 1):
        action = decide_next_action(goal, observations, used, iteration=iteration)
        if action is None:
            c_ok, c_msg = critique_enough(goal, observations)
            crit = trace.add(
                "critique",
                "Данных достаточно" if c_ok else "Останавливаюсь — тулов больше нет",
                detail=c_msg,
                iteration=iteration,
            )
            await _emit(crit)
            break

        plan = trace.add(
            "plan",
            action.title,
            detail=action.detail or action.tool,
            status="running",
            iteration=iteration,
        )
        await _emit(plan)
        plan.status = "done"

        tool_step = trace.add(
            "tool",
            f"Тул: {action.tool}",
            detail=action.detail or action.tool,
            status="running",
            iteration=iteration,
        )
        await _emit(tool_step)

        try:
            facts, srcs = await _execute_tool(
                action.tool,
                action.args,
                db=db,
                documents=documents,
                question=q,
                include_corax=include_corax,
            )
            used.append(action.tool)
            tool_step.status = "done"
            tool_step.detail = (action.detail or action.tool) + f" · {len(facts)} симв."
        except Exception as e:
            tool_step.status = "failed"
            tool_step.detail = str(e)[:200]
            await _emit(tool_step)
            facts, srcs = "", []

        summary, useful = _obs_summary(action.tool, facts)
        obs = AgentObservation(
            tool=action.tool,
            summary=summary,
            facts=facts,
            useful=useful,
            sources=srcs,
        )
        observations.append(obs)
        sources.extend(srcs)
        obs_step = trace.add(
            "observe",
            summary,
            detail=(facts[:280] + "…") if len(facts) > 280 else facts,
            iteration=iteration,
        )
        await _emit(obs_step)

        c_ok, c_msg = critique_enough(goal, observations)
        crit = trace.add(
            "critique",
            "Цель закрыта" if c_ok else "Нужен ещё шаг",
            detail=c_msg,
            iteration=iteration,
        )
        await _emit(crit)
        if c_ok:
            break

        # Avoid identical empty retries.
        if not useful and action.tool in used[:-1]:
            break

    # Final answer from scratchpad
    ans_run = trace.add("answer", "Формирую ответ…", status="running", iteration=len(observations))
    await _emit(ans_run)
    messages = build_scratchpad_messages(goal, observations, system_prompt=system_prompt)
    content = ""
    try:
        final = await lm_studio_chat_raw(
            messages,
            base_url=base_url,
            model=model,
            mode="rag",
            response_mode=response_mode,
            tools=None,
        )
        content = final.content or ""
        last_model = final.model
    except Exception as e:
        content = f"Не удалось получить ответ модели: {e}"
        ans_run.status = "failed"
        ans_run.detail = str(e)[:200]
        await _emit(ans_run)

    # Refusal with some facts → one forced retry answer
    if _looks_like_refusal(content) and any(o.useful for o in observations):
        retry = trace.add(
            "critique",
            "Отказ при наличии фактов — переспрашиваю",
            detail="Повтор финального ответа по scratchpad",
            iteration=len(observations),
        )
        await _emit(retry)
        messages.append(
            {
                "role": "user",
                "content": (
                    "В фактах уже есть данные. Запрещено писать «в контексте нет». "
                    "Перечисли конкретные сущности из блока «Факты»."
                ),
            }
        )
        try:
            final = await lm_studio_chat_raw(
                messages,
                base_url=base_url,
                model=model,
                mode="rag",
                response_mode=response_mode,
                tools=None,
            )
            content = final.content or content
            last_model = final.model or last_model
        except Exception:
            pass

    ans_run.status = "done"
    ans_run.title = "Ответ готов"
    ans_run.detail = f"{len(content)} симв."
    await _emit(ans_run)

    return GoalAgentResult(
        content=content,
        model=last_model,
        tools_used=list(dict.fromkeys(used)),
        sources=[s.to_dict() for s in sources][:24],
        rounds=len(observations),
        path="goal",
        goal=goal.to_dict(),
        trace=trace.as_dicts(),
        stats={"focus": focus, "iters": len(observations), "criteria": goal.criteria},
    )


async def _iter_goal_live(
    *,
    db: AsyncSession,
    question: str,
    documents: list[WikiRagDocument],
    history: list[dict[str, str]] | None,
    include_corax: bool,
    base_url: str | None,
    model: str | None,
    response_mode: str,
    system_prompt: str | None,
) -> AsyncIterator[tuple[str, dict[str, Any] | None]]:
    """Live goal loop with step yields between tool calls."""
    raw_q = (question or "").strip()
    q = retrieval_question(raw_q, history) or raw_q
    focus = classify_wikirag_question(q)
    goal = build_goal(q, focus)
    trace = _Trace()
    observations: list[AgentObservation] = []
    used: list[str] = []
    sources: list[RagSource] = []
    last_model: str | None = None

    g = trace.add("goal", goal.text, detail="; ".join(goal.criteria), iteration=0)
    yield ("step", g.to_dict())
    yield ("progress", {"stage": "goal", "label": g.title})

    for iteration in range(1, _MAX_ASK_ITERS + 1):
        action = decide_next_action(goal, observations, used, iteration=iteration)
        if action is None:
            c_ok, c_msg = critique_enough(goal, observations)
            c = trace.add(
                "critique",
                "Данных достаточно" if c_ok else "Останавливаюсь",
                detail=c_msg,
                iteration=iteration,
            )
            yield ("step", c.to_dict())
            break

        p = trace.add("plan", action.title, detail=action.detail, status="running", iteration=iteration)
        yield ("step", p.to_dict())
        p.status = "done"
        yield ("step", p.to_dict())

        t = trace.add(
            "tool",
            f"Тул: {action.tool}",
            detail=action.detail,
            status="running",
            iteration=iteration,
        )
        yield ("step", t.to_dict())
        yield ("progress", {"stage": "tool", "label": t.title, "tool": action.tool})

        try:
            facts, srcs = await _execute_tool(
                action.tool,
                action.args,
                db=db,
                documents=documents,
                question=q,
                include_corax=include_corax,
            )
            used.append(action.tool)
            t.status = "done"
            t.detail = f"{action.detail or action.tool} · {len(facts)} симв."
        except Exception as e:
            facts, srcs = "", []
            t.status = "failed"
            t.detail = str(e)[:200]
        yield ("step", t.to_dict())

        summary, useful = _obs_summary(action.tool, facts)
        observations.append(
            AgentObservation(tool=action.tool, summary=summary, facts=facts, useful=useful, sources=srcs)
        )
        sources.extend(srcs)
        o = trace.add(
            "observe",
            summary,
            detail=(facts[:280] + "…") if len(facts) > 280 else facts,
            iteration=iteration,
        )
        yield ("step", o.to_dict())

        c_ok, c_msg = critique_enough(goal, observations)
        c = trace.add(
            "critique",
            "Цель закрыта" if c_ok else "Нужен ещё шаг",
            detail=c_msg,
            iteration=iteration,
        )
        yield ("step", c.to_dict())
        if c_ok:
            break
        if not useful and used.count(action.tool) > 1:
            break

    a = trace.add("answer", "Формирую ответ…", status="running", iteration=len(observations))
    yield ("step", a.to_dict())
    yield ("progress", {"stage": "generate", "label": "Собирает ответ…"})

    messages = build_scratchpad_messages(goal, observations, system_prompt=system_prompt)
    content = ""
    try:
        final = await lm_studio_chat_raw(
            messages,
            base_url=base_url,
            model=model,
            mode="rag",
            response_mode=response_mode,
            tools=None,
        )
        content = final.content or ""
        last_model = final.model
    except Exception as e:
        content = f"Не удалось получить ответ модели: {e}"
        a.status = "failed"
        a.detail = str(e)[:200]
        yield ("step", a.to_dict())

    if _looks_like_refusal(content) and any(o.useful for o in observations):
        r = trace.add(
            "critique",
            "Отказ при наличии фактов — переспрашиваю",
            detail="Повтор финального ответа",
            iteration=len(observations),
        )
        yield ("step", r.to_dict())
        messages.append(
            {
                "role": "user",
                "content": (
                    "В фактах уже есть данные. Запрещено писать «в контексте нет». "
                    "Перечисли конкретные сущности из блока «Факты»."
                ),
            }
        )
        try:
            final = await lm_studio_chat_raw(
                messages,
                base_url=base_url,
                model=model,
                mode="rag",
                response_mode=response_mode,
                tools=None,
            )
            content = final.content or content
            last_model = final.model or last_model
        except Exception:
            pass

    a.status = "done"
    a.title = "Ответ готов"
    a.detail = f"{len(content)} симв."
    yield ("step", a.to_dict())

    if content:
        step = max(24, len(content) // 40)
        for i in range(0, len(content), step):
            yield ("delta", {"text": content[i : i + step], "model": last_model})

    yield (
        "done",
        {
            "content": content,
            "model": last_model,
            "tools_used": list(dict.fromkeys(used)),
            "sources": [s.to_dict() for s in sources][:24],
            "rounds": len(observations),
            "path": "goal",
            "focus": focus,
            "goal": goal.to_dict(),
            "trace": trace.as_dicts(),
        },
    )
