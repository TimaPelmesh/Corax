import ipaddress
import json
import secrets
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_editor_or_superuser, get_current_user
from app.config import settings
from app.database import get_db
from app.models import TicketHandlerConfig, TicketHandlerRun, User
from app.rate_limit import limiter
from app.schemas import (
    TicketHandlerConfigOut,
    TicketHandlerConfigUpdate,
    TicketHandlerIntakeRequest,
    TicketHandlerIntakeResponse,
    TicketHandlerPipelineStep,
    TicketHandlerPublicContextOut,
    TicketHandlerRunOut,
    TicketHandlerStatsOut,
    TicketHandlerStatsPoint,
)
from app.ticket_handler_runtime import (
    DEFAULT_SYSTEM_PROMPT,
    IntakeInput,
    enrich_ticket_ai_task,
    resolve_computer,
    resolve_requester,
    run_intake,
)

router = APIRouter(prefix="/ticket-handler", tags=["ticket-handler"])

KNOWN_STEP_IDS = frozenset({"intake", "create_ticket", "classify", "enrich", "rag", "llm", "decide", "reply"})
LEGACY_PIPELINE_IDS = frozenset({"rag", "decide", "reply"})

DEFAULT_PIPELINE: list[dict[str, Any]] = [
    {"id": "intake", "enabled": True, "label": "Приём с ярлыка", "params": {}},
    {"id": "create_ticket", "enabled": True, "label": "Создание заявки", "params": {}},
    {
        "id": "classify",
        "enabled": True,
        "label": "AI: категория и тема",
        "params": {},
    },
]


def _default_pipeline_json() -> str:
    return json.dumps(DEFAULT_PIPELINE, ensure_ascii=False)


def _parse_pipeline(raw: str | None) -> list[TicketHandlerPipelineStep]:
    try:
        data = json.loads(raw or "[]")
    except json.JSONDecodeError:
        data = []
    if not isinstance(data, list) or not data:
        data = DEFAULT_PIPELINE
    out: list[TicketHandlerPipelineStep] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        sid = str(item.get("id") or "").strip()
        if not sid:
            continue
        params = item.get("params") if isinstance(item.get("params"), dict) else {}
        out.append(
            TicketHandlerPipelineStep(
                id=sid,
                enabled=bool(item.get("enabled", True)),
                label=str(item.get("label") or sid),
                params=params,
            )
        )
    return out or [TicketHandlerPipelineStep(**s) for s in DEFAULT_PIPELINE]


def _pipeline_to_json(steps: list[TicketHandlerPipelineStep]) -> str:
    return json.dumps([s.model_dump() for s in steps], ensure_ascii=False)


def _validate_pipeline(steps: list[TicketHandlerPipelineStep]) -> list[str]:
    errors: list[str] = []
    if not steps:
        errors.append("Цепочка пуста")
        return errors
    seen: set[str] = set()
    for i, step in enumerate(steps):
        sid = (step.id or "").strip()
        if not sid:
            errors.append(f"Шаг #{i + 1}: пустой id")
            continue
        if sid in seen:
            errors.append(f"Дубликат id: {sid}")
        seen.add(sid)
        if sid not in KNOWN_STEP_IDS:
            errors.append(f"Неизвестный шаг: {sid}")
        if not isinstance(step.params, dict):
            errors.append(f"Шаг {sid}: params должен быть объектом")
    if "intake" not in seen:
        errors.append("Обязательный шаг intake отсутствует")
    if "llm" not in seen:
        errors.append("Обязательный шаг llm отсутствует")
    return errors


def _row_to_out(row: TicketHandlerConfig) -> TicketHandlerConfigOut:
    return TicketHandlerConfigOut(
        enabled=bool(row.enabled),
        processor_mode=(row.processor_mode or "local").strip() or "local",
        remote_base_url=(row.remote_base_url or "").strip(),
        client_secret=(row.client_secret or "").strip(),
        llm_provider=(row.llm_provider or "ollama").strip() or "ollama",
        llm_base_url=(row.llm_base_url or "").strip() or "http://127.0.0.1:11434/v1",
        llm_model=(row.llm_model or "").strip(),
        include_corax_knowledge=bool(row.include_corax_knowledge),
        include_wiki_docs=bool(row.include_wiki_docs),
        auto_create_ticket=bool(row.auto_create_ticket),
        default_priority=(row.default_priority or "normal").strip() or "normal",
        default_category=(row.default_category or "").strip(),
        default_status=(row.default_status or "new").strip() or "new",
        system_prompt=(row.system_prompt or "").strip() or DEFAULT_SYSTEM_PROMPT,
        pipeline=_parse_pipeline(row.pipeline_json),
        updated_at=row.updated_at,
    )


async def _get_or_create_config(db: AsyncSession) -> TicketHandlerConfig:
    row = await db.get(TicketHandlerConfig, 1)
    healed = False
    if row is None:
        lm_url = (settings.lm_studio_base_url or "").strip() or "http://127.0.0.1:11434/v1"
        lm_model = (settings.lm_studio_model or "").strip()
        # Prefer Ollama-style default when URL looks like Ollama; else keep settings.
        provider = "ollama" if "11434" in lm_url or "ollama" in lm_url.lower() else "lm_studio"
        if provider == "ollama" and not lm_model:
            lm_model = "qwen2.5:3b"
        row = TicketHandlerConfig(
            id=1,
            enabled=False,
            processor_mode="local",
            remote_base_url="",
            client_secret=secrets.token_urlsafe(24),
            llm_provider=provider,
            llm_base_url=lm_url,
            llm_model=lm_model,
            include_corax_knowledge=True,
            include_wiki_docs=True,
            auto_create_ticket=True,
            default_priority="normal",
            default_category="",
            default_status="open",
            system_prompt=DEFAULT_SYSTEM_PROMPT,
            pipeline_json=_default_pipeline_json(),
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row

    # Heal incomplete first-time / legacy rows so beta works out of the box after upgrade.
    if not (row.client_secret or "").strip():
        row.client_secret = secrets.token_urlsafe(24)
        healed = True
    if not (row.pipeline_json or "").strip() or (row.pipeline_json or "").strip() in {"[]", "null"}:
        row.pipeline_json = _default_pipeline_json()
        healed = True
    else:
        try:
            steps = json.loads(row.pipeline_json or "[]")
        except json.JSONDecodeError:
            steps = []
        if isinstance(steps, list):
            ids = {str(s.get("id") or "") for s in steps if isinstance(s, dict)}
            if ids & LEGACY_PIPELINE_IDS or "create_ticket" not in ids:
                row.pipeline_json = _default_pipeline_json()
                healed = True
    if not (row.system_prompt or "").strip():
        row.system_prompt = DEFAULT_SYSTEM_PROMPT
        healed = True
    elif "дай полезный ответ" in (row.system_prompt or "").lower() or (
        "дружелюбный помощник" in (row.system_prompt or "").lower()
        and "category" not in (row.system_prompt or "").lower()
        and "категор" not in (row.system_prompt or "").lower()
    ):
        row.system_prompt = DEFAULT_SYSTEM_PROMPT
        healed = True
    if not bool(row.auto_create_ticket):
        row.auto_create_ticket = True
        healed = True
    # Empty = auto-classify from catalog; migrate legacy placeholder.
    if (row.default_category or "").strip().lower() in {"ticket-handler", "ticket_handler", "handler"}:
        row.default_category = ""
        healed = True
    status = (row.default_status or "").strip().lower()
    if not status or status == "new":
        row.default_status = "open"
        healed = True
    if not (row.llm_base_url or "").strip():
        row.llm_base_url = (settings.lm_studio_base_url or "").strip() or "http://127.0.0.1:11434/v1"
        healed = True
    if not (row.llm_model or "").strip():
        row.llm_model = (settings.lm_studio_model or "").strip() or "qwen2.5:3b"
        healed = True
    if not (row.llm_provider or "").strip():
        url = (row.llm_base_url or "").lower()
        row.llm_provider = "ollama" if "11434" in url or "ollama" in url else "lm_studio"
        healed = True
    if healed:
        await db.commit()
        await db.refresh(row)
    return row


def _parse_day(value: str | None, *, default: date) -> date:
    if not value or not value.strip():
        return default
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Некорректная дата: {value}") from exc


@router.get("/config", response_model=TicketHandlerConfigOut)
async def get_ticket_handler_config(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_config(db)
    return _row_to_out(row)


@router.put("/config", response_model=TicketHandlerConfigOut)
async def update_ticket_handler_config(
    body: TicketHandlerConfigUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_config(db)
    patch = body.model_dump(exclude_unset=True)

    if "enabled" in patch and patch["enabled"] is not None:
        row.enabled = bool(patch["enabled"])
    if "processor_mode" in patch and patch["processor_mode"] is not None:
        mode = str(patch["processor_mode"] or "").strip().lower()
        if mode not in {"local", "remote"}:
            raise HTTPException(status_code=400, detail="processor_mode: local или remote")
        row.processor_mode = mode
    if "remote_base_url" in patch and patch["remote_base_url"] is not None:
        row.remote_base_url = str(patch["remote_base_url"] or "").strip()
    if "client_secret" in patch and patch["client_secret"] is not None:
        row.client_secret = str(patch["client_secret"] or "").strip()
    if "llm_provider" in patch and patch["llm_provider"] is not None:
        prov = str(patch["llm_provider"] or "").strip().lower()
        if prov not in {"ollama", "lm_studio"}:
            raise HTTPException(status_code=400, detail="llm_provider: ollama или lm_studio")
        row.llm_provider = prov
    if "llm_base_url" in patch and patch["llm_base_url"] is not None:
        row.llm_base_url = str(patch["llm_base_url"] or "").strip() or "http://127.0.0.1:11434/v1"
    if "llm_model" in patch and patch["llm_model"] is not None:
        row.llm_model = str(patch["llm_model"] or "").strip()
    if "include_corax_knowledge" in patch and patch["include_corax_knowledge"] is not None:
        row.include_corax_knowledge = bool(patch["include_corax_knowledge"])
    if "include_wiki_docs" in patch and patch["include_wiki_docs"] is not None:
        row.include_wiki_docs = bool(patch["include_wiki_docs"])
    if "auto_create_ticket" in patch and patch["auto_create_ticket"] is not None:
        row.auto_create_ticket = bool(patch["auto_create_ticket"])
    if "default_priority" in patch and patch["default_priority"] is not None:
        row.default_priority = str(patch["default_priority"] or "").strip() or "normal"
    if "default_category" in patch and patch["default_category"] is not None:
        row.default_category = str(patch["default_category"] or "").strip()
    if "default_status" in patch and patch["default_status"] is not None:
        row.default_status = str(patch["default_status"] or "").strip() or "new"
    if "system_prompt" in patch and patch["system_prompt"] is not None:
        row.system_prompt = str(patch["system_prompt"] or "").strip()
    if "pipeline" in patch and patch["pipeline"] is not None:
        steps = [TicketHandlerPipelineStep.model_validate(s) for s in patch["pipeline"]]
        errs = _validate_pipeline(steps)
        if errs:
            raise HTTPException(status_code=400, detail="; ".join(errs))
        row.pipeline_json = _pipeline_to_json(steps)

    await db.commit()
    await db.refresh(row)
    return _row_to_out(row)


@router.post("/config/regenerate-secret", response_model=TicketHandlerConfigOut)
async def regenerate_client_secret(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_config(db)
    row.client_secret = secrets.token_urlsafe(24)
    await db.commit()
    await db.refresh(row)
    return _row_to_out(row)


@router.get("/runs", response_model=list[TicketHandlerRunOut])
async def list_ticket_handler_runs(
    limit: int = Query(default=50, ge=1, le=200),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = (
        select(TicketHandlerRun)
        .order_by(TicketHandlerRun.created_at.desc(), TicketHandlerRun.id.desc())
        .limit(limit)
    )
    rows = (await db.execute(q)).scalars().all()
    return [
        TicketHandlerRunOut(
            id=r.id,
            created_at=r.created_at,
            status=r.status or "ok",
            latency_ms=r.latency_ms,
            hostname=r.hostname,
            requester_name=r.requester_name,
            service_request_id=r.service_request_id,
            error_detail=r.error_detail,
        )
        for r in rows
    ]


@router.get("/stats", response_model=TicketHandlerStatsOut)
async def ticket_handler_stats(
    from_date: str | None = Query(default=None, alias="from"),
    to_date: str | None = Query(default=None, alias="to"),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    today = datetime.now(timezone.utc).date()
    d_to = _parse_day(to_date, default=today)
    d_from = _parse_day(from_date, default=d_to - timedelta(days=13))
    if d_from > d_to:
        d_from, d_to = d_to, d_from

    start = datetime(d_from.year, d_from.month, d_from.day, tzinfo=timezone.utc)
    end = datetime(d_to.year, d_to.month, d_to.day, tzinfo=timezone.utc) + timedelta(days=1)

    rows = (
        await db.execute(
            select(TicketHandlerRun).where(
                TicketHandlerRun.created_at >= start,
                TicketHandlerRun.created_at < end,
            )
        )
    ).scalars().all()

    by_day: dict[str, TicketHandlerStatsPoint] = {}
    cur = d_from
    while cur <= d_to:
        key = cur.isoformat()
        by_day[key] = TicketHandlerStatsPoint(date=key)
        cur += timedelta(days=1)

    total = created = skipped = error = ok = 0
    latency_sum = 0
    latency_n = 0

    for r in rows:
        st = (r.status or "ok").strip().lower()
        total += 1
        if st == "created_ticket":
            created += 1
        elif st == "skipped_ticket":
            skipped += 1
        elif st == "error":
            error += 1
        else:
            ok += 1
            st = "ok"
        if r.latency_ms is not None:
            latency_sum += int(r.latency_ms)
            latency_n += 1
        day_key = (r.created_at.astimezone(timezone.utc).date().isoformat() if r.created_at else None)
        if day_key and day_key in by_day:
            pt = by_day[day_key]
            pt.total += 1
            if st == "created_ticket":
                pt.created_ticket += 1
            elif st == "skipped_ticket":
                pt.skipped_ticket += 1
            elif st == "error":
                pt.error += 1
            else:
                pt.ok += 1

    return TicketHandlerStatsOut(
        total=total,
        created_ticket=created,
        skipped_ticket=skipped,
        error=error,
        ok=ok,
        avg_latency_ms=(latency_sum / latency_n) if latency_n else None,
        series=list(by_day.values()),
    )


def _client_host(request: Request) -> str:
    return (request.client.host if request.client else "") or ""


def _is_private_client(request: Request) -> bool:
    if settings.environment == "test":
        return True
    host = _client_host(request)
    try:
        return ipaddress.ip_address(host).is_private
    except ValueError:
        return False


def _secret_ok(cfg: TicketHandlerConfig, provided: str | None, request: Request) -> bool:
    expected = (cfg.client_secret or "").strip()
    if not expected:
        return False
    got = (provided or "").strip()
    header = (request.headers.get("x-corax-handler-secret") or "").strip()
    token = got or header
    if not token or len(token) != len(expected):
        return False
    return secrets.compare_digest(expected, token)


def _require_intake_access(cfg: TicketHandlerConfig, request: Request, secret: str | None) -> None:
    if not bool(cfg.enabled) and settings.environment != "test":
        raise HTTPException(status_code=404, detail="Обработчик заявок выключен")
    if _secret_ok(cfg, secret, request):
        return
    if _is_private_client(request):
        return
    raise HTTPException(
        status_code=403,
        detail="Нужен секрет клиента или доступ из локальной сети",
    )


@router.get("/public/context", response_model=TicketHandlerPublicContextOut)
async def public_context(
    request: Request,
    hostname: str = Query(..., min_length=1, max_length=255),
    secret: str | None = Query(default=None, max_length=255),
    db: AsyncSession = Depends(get_db),
):
    cfg = await _get_or_create_config(db)
    _require_intake_access(cfg, request, secret)
    computer = await resolve_computer(db, hostname)
    requester = await resolve_requester(db, computer, hostname)
    return TicketHandlerPublicContextOut(
        enabled=bool(cfg.enabled),
        hostname=(computer.hostname if computer else hostname.strip()),
        computer_id=computer.id if computer else None,
        location=None,
        requester_hint=requester,
    )


@router.post("/intake", response_model=TicketHandlerIntakeResponse)
@limiter.limit(settings.rate_limit_self_service)
async def intake(
    request: Request,
    body: Annotated[TicketHandlerIntakeRequest, Body()],
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    cfg = await _get_or_create_config(db)
    _require_intake_access(cfg, request, body.secret)

    if (cfg.processor_mode or "local").strip().lower() == "remote":
        remote = (cfg.remote_base_url or "").strip().rstrip("/")
        if not remote:
            raise HTTPException(status_code=400, detail="Remote URL не задан")

    result = await run_intake(
        db,
        cfg,
        IntakeInput(
            hostname=body.hostname,
            title=body.title,
            description=body.description or "",
            dry_run=bool(body.dry_run),
            secret=body.secret,
        ),
    )
    if result.schedule_enrich_id:
        background_tasks.add_task(enrich_ticket_ai_task, result.schedule_enrich_id)
    return TicketHandlerIntakeResponse(
        ok=result.ok,
        answer=result.answer,
        status=result.status,
        run_id=result.run_id,
        request_id=result.request_id,
        ticket_no=result.ticket_no,
        latency_ms=result.latency_ms,
        hostname=result.hostname,
        requester_name=result.requester_name,
        model=result.model,
        error_detail=result.error_detail,
        dry_run=result.dry_run,
    )


@router.post("/sandbox", response_model=TicketHandlerIntakeResponse)
async def sandbox_intake(
    body: TicketHandlerIntakeRequest,
    background_tasks: BackgroundTasks,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Admin playground: same pipeline; dry_run defaults to True for safety."""
    cfg = await _get_or_create_config(db)
    dry_run = True if "dry_run" not in body.model_fields_set else bool(body.dry_run)
    if not bool(cfg.enabled) and not dry_run:
        raise HTTPException(status_code=400, detail="Включите обработчик в настройках для live-прогона")
    result = await run_intake(
        db,
        cfg,
        IntakeInput(
            hostname=body.hostname,
            title=body.title,
            description=body.description or "",
            dry_run=dry_run,
            secret=None,
        ),
    )
    if result.schedule_enrich_id:
        background_tasks.add_task(enrich_ticket_ai_task, result.schedule_enrich_id)
    return TicketHandlerIntakeResponse(
        ok=result.ok,
        answer=result.answer,
        status=result.status,
        run_id=result.run_id,
        request_id=result.request_id,
        ticket_no=result.ticket_no,
        latency_ms=result.latency_ms,
        hostname=result.hostname,
        requester_name=result.requester_name,
        model=result.model,
        error_detail=result.error_detail,
        dry_run=result.dry_run,
    )
