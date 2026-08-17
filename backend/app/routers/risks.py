from __future__ import annotations

import hashlib
import json
import re
import time
from collections import Counter
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_editor_or_superuser, get_current_user
from app.config import settings
from app.database import get_db
from app.models import Computer, RiskFindingAck, RiskSnapshot, User
from app.rate_limit import limiter
from app.risk_engine import build_risk_overview, invalidate_risk_overview_cache
from app.risk_schemas import (
    RiskAiInsight,
    RiskAiRequest,
    RiskFindingAction,
    RiskFindingActionOut,
    RiskHistory,
    RiskHistoryPoint,
    RiskOverview,
)
from app.wikirag_lm import is_bad_lm_answer, lm_studio_chat, normalize_lm_base_url


router = APIRouter(prefix="/risks", tags=["risks"])

_AI_CACHE_SECONDS = 600.0
_AI_CACHE: dict[str, tuple[float, RiskAiInsight]] = {}
_FINDING_ID_RE = re.compile(r"^\d+:[A-Za-z0-9._\-]+$")


@router.get("/overview", response_model=RiskOverview)
async def risk_overview(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await build_risk_overview(db)


@router.get("/history", response_model=RiskHistory)
async def risk_history(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(90, ge=1, le=180),
):
    rows = list(
        (
            await db.execute(
                select(RiskSnapshot).order_by(RiskSnapshot.created_at.desc()).limit(limit)
            )
        )
        .scalars()
        .all()
    )
    rows.reverse()
    return RiskHistory(
        items=[
            RiskHistoryPoint(
                created_at=row.created_at,
                fleet_health_score=row.fleet_health_score,
                average_risk_score=row.average_risk_score,
                computers_total=row.computers_total,
                computers_critical=row.computers_critical,
                computers_high=row.computers_high,
                computers_medium=row.computers_medium,
                computers_healthy=row.computers_healthy,
                findings_open=row.findings_open,
            )
            for row in rows
        ]
    )


@router.post("/findings/actions", response_model=RiskFindingActionOut)
async def risk_finding_action(
    body: RiskFindingAction,
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    finding_id = body.finding_id.strip()
    if not _FINDING_ID_RE.match(finding_id):
        raise HTTPException(status_code=400, detail="Некорректный идентификатор наблюдения")
    computer_id = int(finding_id.split(":", 1)[0])
    computer = await db.get(Computer, computer_id)
    if computer is None:
        raise HTTPException(status_code=404, detail="Компьютер не найден")

    existing = await db.scalar(select(RiskFindingAck).where(RiskFindingAck.finding_id == finding_id))
    now = datetime.now(timezone.utc)
    if body.status == "open":
        if existing is not None:
            await db.delete(existing)
    elif existing is not None:
        existing.status = body.status
        existing.note = (body.note or "").strip() or None
        existing.user_id = current.id
        existing.updated_at = now
    else:
        db.add(
            RiskFindingAck(
                finding_id=finding_id,
                computer_id=computer_id,
                status=body.status,
                note=(body.note or "").strip() or None,
                user_id=current.id,
                created_at=now,
                updated_at=now,
            )
        )
    await db.commit()
    invalidate_risk_overview_cache()
    return RiskFindingActionOut(ok=True, finding_id=finding_id, status=body.status)


def _ai_context(overview: RiskOverview) -> dict:
    patterns: Counter[tuple[str, str, str]] = Counter()
    for finding in overview.findings:
        patterns[(finding.severity, finding.title, finding.recommendation)] += 1
    return {
        "fleet_health_score": overview.fleet_health_score,
        "average_risk_score": overview.average_risk_score,
        "computers_total": overview.computers_total,
        "computers_by_level": {
            "critical": overview.computers_critical,
            "high": overview.computers_high,
            "medium": overview.computers_medium,
            "healthy": overview.computers_healthy,
        },
        "antivirus_posture": {
            "protected": overview.antivirus_protected,
            "attention": overview.antivirus_attention,
            "unknown": overview.antivirus_unknown,
        },
        "categories": [
            {
                "name": category.label,
                "affected_computers": category.affected_computers,
                "finding_count": category.finding_count,
                "risk_points": category.risk_points,
            }
            for category in overview.categories
        ],
        # Deliberately counts-only: no hostnames, IPs, serials, users or raw payload.
        "top_patterns": [
            {
                "severity": severity,
                "title": title,
                "recommendation": recommendation,
                "affected_computers": count,
            }
            for (severity, title, recommendation), count in patterns.most_common(20)
        ],
    }


@router.post("/ai-insights", response_model=RiskAiInsight)
@limiter.limit("10/hour")
async def risk_ai_insights(
    request: Request,
    body: RiskAiRequest,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    overview = await build_risk_overview(db)
    context = _ai_context(overview)
    context_json = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    cache_key = hashlib.sha256(
        f"{body.base_url}|{body.model}|{body.response_mode}|{context_json}".encode("utf-8")
    ).hexdigest()
    now_mono = time.monotonic()
    cached = _AI_CACHE.get(cache_key)
    if not body.force and cached and cached[0] > now_mono:
        return cached[1].model_copy(update={"cached": True})

    system = (
        "Ты локальный аналитик рисков CORAX. Тебе передана только агрегированная сводка, "
        "рассчитанная детерминированными правилами. Не меняй оценки, не выдумывай уязвимости, "
        "hostname или факты. Найди 3–5 практически полезных закономерностей и приоритетов. "
        "Разделяй наблюдение и рекомендацию. Пиши по-русски, коротко, без JSON, без таблиц. "
        "Учитывай масштаб: единичная проблема не должна звучать как проблема всего парка."
    )
    user = (
        "Проанализируй сводку рисков парка. Сначала дай один вывод руководителю, затем "
        "маркированный список приоритетных действий на ближайшие 7 дней.\n\n"
        f"Сводка CORAX:\n{context_json}"
    )
    try:
        base_url = normalize_lm_base_url(body.base_url)
        if settings.corax_docker and re.match(
            r"^https?://(127\.0\.0\.1|localhost):11434/v1$", base_url
        ):
            base_url = "http://host.docker.internal:11434/v1"
        text, used_model = await lm_studio_chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            base_url=base_url,
            model=body.model,
            mode="simple",
            response_mode=body.response_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if is_bad_lm_answer(text):
        raise HTTPException(
            status_code=502,
            detail="Локальная модель вернула неполный или некорректный анализ.",
        )

    result = RiskAiInsight(
        generated_at=datetime.now(timezone.utc),
        model=used_model,
        text=text.strip(),
        cached=False,
    )
    _AI_CACHE[cache_key] = (now_mono + _AI_CACHE_SECONDS, result)
    return result
