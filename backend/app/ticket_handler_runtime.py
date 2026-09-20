"""Ticket-handler: create ticket first, then AI classifies category + title suggestion."""

from __future__ import annotations

import json
import logging
import re
import secrets
import time
import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import hash_password
from app.models import (
    Computer,
    ServiceRequest,
    TicketHandlerConfig,
    TicketHandlerRun,
    User,
    service_request_assignees,
)
from app.routers.agent import _reported_assigned_user
from app.search_index import index_service_request
from app.ticket_client_identity import is_dockerish_ip, normalize_ip, reverse_dns_shortname, sam_account
from app.service_request_tickets import ensure_ticket_no
from app.wikirag_lm import coerce_parsed, lm_studio_chat

logger = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = (
    "Ты — классификатор заявок службы поддержки CORAX. "
    "По тексту заявки выбери ровно одну категорию из списка и предложи короткую понятную тему. "
    "Отвечай только JSON без markdown."
)

CLASSIFY_SYSTEM = (
    "Ты помощник IT-поддержки CORAX. "
    "Верни строго JSON: "
    '{"category":"<точная строка из списка категорий>",'
    '"title_suggestion":"<краткая тема заявки по-русски, до 80 символов>"} '
    "Категория должна совпадать со списком. Не выдумывай новые категории."
)


@dataclass
class IntakeInput:
    hostname: str = ""
    title: str = ""
    description: str = ""
    dry_run: bool = False
    secret: str | None = None
    client_ip: str = ""
    sso_login: str | None = None


@dataclass
class ClientIdentity:
    computer: Computer | None
    hostname: str
    requester_name: str | None
    location: str | None


@dataclass
class IntakeResult:
    ok: bool
    answer: str
    status: str  # ok | error | created_ticket | skipped_ticket
    run_id: int | None = None
    request_id: int | None = None
    ticket_no: int | None = None
    latency_ms: int | None = None
    hostname: str | None = None
    requester_name: str | None = None
    model: str | None = None
    error_detail: str | None = None
    dry_run: bool = False
    meta: dict[str, Any] = field(default_factory=dict)
    schedule_enrich_id: int | None = None


@dataclass
class EnrichResult:
    ok: bool
    category: str | None = None
    title_suggestion: str | None = None
    model: str | None = None
    error_detail: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class PublicTicket:
    id: int
    ticket_no: int | None
    title: str
    status: str
    assignees: list[str]
    opened_at: datetime | None
    updated_at: datetime | None
    closed_at: datetime | None


def _step_enabled(pipeline: list[dict[str, Any]], step_id: str) -> bool:
    for s in pipeline:
        if str(s.get("id") or "") == step_id:
            return bool(s.get("enabled", True))
    return True


def _parse_pipeline(raw: str | None) -> list[dict[str, Any]]:
    try:
        data = json.loads(raw or "[]")
    except json.JSONDecodeError:
        data = []
    return data if isinstance(data, list) else []


async def _bot_user(db: AsyncSession) -> User:
    row = await db.scalar(select(User).where(User.username == "ticket-handler-bot").limit(1))
    if row:
        return row
    row = User(
        username="ticket-handler-bot",
        full_name="CORAX Ticket Handler",
        hashed_password=hash_password(secrets.token_urlsafe(24)),
        is_active=True,
        is_superuser=False,
        is_ldap=False,
        role="directory",
    )
    db.add(row)
    await db.flush()
    return row


def hostname_candidates(hostname: str) -> list[str]:
    """Lookup keys: exact, NETBIOS, short name without FQDN / trailing $."""
    raw = (hostname or "").strip()
    if not raw:
        return []
    out: list[str] = []

    def add(value: str) -> None:
        v = value.strip().rstrip(".").lower()
        if v and v not in out:
            out.append(v)

    add(raw)
    if "\\" in raw:
        add(raw.rsplit("\\", 1)[-1])
    short = raw.split(".", 1)[0]
    if "\\" in short:
        short = short.rsplit("\\", 1)[-1]
    add(short)
    if short.endswith("$"):
        add(short[:-1])
    return out


def requester_label_for_user(user: User) -> str:
    """Same shape as the ticket form directory picker: «Имя (login)»."""
    full = (user.full_name or "").strip()
    uname = (user.username or "").strip()
    if full and uname:
        return f"{full} ({uname})"[:255]
    return (full or uname)[:255]


def _is_directory_person(user: User) -> bool:
    if bool(user.is_ldap):
        return True
    return (user.role or "").strip().lower() == "directory" and not (user.username or "").endswith("-bot")


async def _follow_directory_user(db: AsyncSession, user: User | None) -> User | None:
    if user is None:
        return None
    if user.linked_directory_user_id:
        linked = await db.get(User, user.linked_directory_user_id)
        if linked is not None and linked.is_active:
            return linked
    if _is_directory_person(user):
        return user
    twin = await db.scalar(
        select(User)
        .where(
            func.lower(User.username) == (user.username or "").strip().lower(),
            User.is_ldap.is_(True),
            User.is_active.is_(True),
            User.id != user.id,
        )
        .limit(1)
    )
    return twin or user


async def resolve_computer(db: AsyncSession, hostname: str) -> Computer | None:
    keys = hostname_candidates(hostname)
    if not keys:
        return None
    row = await db.scalar(
        select(Computer)
        .where(func.lower(Computer.hostname).in_(keys))
        .order_by(Computer.last_report_at.desc().nulls_last())
        .limit(1)
    )
    if row is not None:
        return row
    short = keys[-1]
    if any(ch in short for ch in "%_"):
        return None
    return await db.scalar(
        select(Computer)
        .where(func.lower(Computer.hostname).like(f"{short}.%"))
        .order_by(Computer.last_report_at.desc().nulls_last())
        .limit(1)
    )


async def resolve_directory_user(db: AsyncSession, computer: Computer | None) -> User | None:
    """LDAP/directory person at this PC — never the hostname itself."""
    if computer is None:
        return None
    from_agent: User | None = None
    if computer.raw_payload:
        try:
            payload = json.loads(computer.raw_payload)
            extended = payload.get("extended") if isinstance(payload, dict) else None
        except json.JSONDecodeError:
            extended = None
        from_agent = await _reported_assigned_user(db, extended if isinstance(extended, dict) else None)
        if from_agent is not None and computer.assigned_user_id is None:
            computer.assigned_user_id = from_agent.id
    assigned = await db.get(User, computer.assigned_user_id) if computer.assigned_user_id else None
    # Prefer the account currently reported by the agent (who is at the keyboard).
    picked = await _follow_directory_user(db, from_agent) or await _follow_directory_user(db, assigned)
    return picked


async def resolve_requester(db: AsyncSession, computer: Computer | None, hostname: str = "") -> str | None:
    del hostname  # PC belongs in computer_id, not in the initiator field.
    user = await resolve_directory_user(db, computer)
    if user is None:
        return None
    label = requester_label_for_user(user)
    return label or None


async def resolve_ldap_user_by_login(db: AsyncSession, login: str | None) -> User | None:
    name = sam_account(login)
    if not name:
        return None
    rows = list(
        (
            await db.execute(
                select(User).where(func.lower(User.username) == name.lower(), User.is_active.is_(True))
            )
        ).scalars().all()
    )
    if not rows:
        return None
    ldap = [u for u in rows if u.is_ldap]
    if ldap:
        return await _follow_directory_user(db, ldap[0])
    return await _follow_directory_user(db, rows[0])


async def resolve_computer_by_ip(db: AsyncSession, ip: str | None) -> Computer | None:
    addr = normalize_ip(ip)
    if not addr or is_dockerish_ip(addr):
        return None
    keys = {addr}
    if ":" not in addr:
        keys.add(f"::ffff:{addr}")
    return await db.scalar(
        select(Computer)
        .where(Computer.ip_address.in_(keys))
        .order_by(Computer.last_report_at.desc().nulls_last())
        .limit(1)
    )


async def resolve_computer_for_user(db: AsyncSession, user: User | None) -> Computer | None:
    if user is None:
        return None
    ids = {user.id}
    if user.linked_directory_user_id:
        ids.add(user.linked_directory_user_id)
    return await db.scalar(
        select(Computer)
        .where(Computer.assigned_user_id.in_(ids))
        .order_by(Computer.last_report_at.desc().nulls_last())
        .limit(1)
    )


async def resolve_client_identity(
    db: AsyncSession,
    *,
    hostname_hint: str = "",
    client_ip: str = "",
    sso_login: str | None = None,
) -> ClientIdentity:
    hint = (hostname_hint or "").strip()
    dns_name: str | None = None
    computer = await resolve_computer(db, hint) if hint else None

    sso_user = await resolve_ldap_user_by_login(db, sso_login)
    if computer is None and sso_user is not None:
        computer = await resolve_computer_for_user(db, sso_user)

    if computer is None:
        computer = await resolve_computer_by_ip(db, client_ip)
    if computer is None and client_ip and not is_dockerish_ip(client_ip):
        try:
            dns_name = await asyncio.wait_for(asyncio.to_thread(reverse_dns_shortname, client_ip), timeout=0.45)
        except (asyncio.TimeoutError, OSError):
            dns_name = None
        if dns_name:
            computer = await resolve_computer(db, dns_name)

    if sso_user is not None:
        requester = requester_label_for_user(sso_user) or None
    else:
        requester = await resolve_requester(db, computer)

    hostname = ((computer.hostname if computer else "") or hint or (dns_name or "")).strip()
    location = ((computer.location or "").strip() if computer is not None else "") or None
    return ClientIdentity(
        computer=computer,
        hostname=hostname,
        requester_name=requester,
        location=location,
    )


def normalize_intake_status(raw: str | None) -> str:
    """New /h tickets wait until IT takes them (assignee or in_progress)."""
    status = (raw or "open").strip().lower() or "open"
    if status in {"new", "in_progress"}:
        return "open"
    return status[:64]


def assignee_public_label(full_name: str | None, username: str | None) -> str | None:
    uname = (username or "").strip()
    if uname.endswith("-bot"):
        return None
    full = (full_name or "").strip()
    label = full or uname
    return label or None


def summarize_public_assignees(names: list[str]) -> list[str]:
    cleaned = [n.strip() for n in names if (n or "").strip()]
    if len(cleaned) > 2:
        return ["IT-поддержка"]
    return cleaned


def _requester_login(label: str | None) -> str | None:
    raw = (label or "").strip()
    if not raw:
        return None
    m = re.search(r"\(([^)]+)\)\s*$", raw)
    if m:
        return sam_account(m.group(1))
    return sam_account(raw)


def _ilike_contains(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def list_public_tickets(
    db: AsyncSession,
    identity: ClientIdentity,
    *,
    limit: int = 40,
) -> list[PublicTicket]:
    """Tickets this employee can monitor on /h — same PC / same AD account."""
    scope: list[Any] = []
    if identity.computer is not None:
        scope.append(ServiceRequest.computer_id == identity.computer.id)
    keys = hostname_candidates(identity.hostname)
    if keys:
        scope.append(func.lower(ServiceRequest.external_id).in_(keys))
    if not scope:
        return []

    stmt = (
        select(ServiceRequest)
        .where(
            ServiceRequest.external_source.in_(("ticket_handler", "self_service")),
            or_(*scope),
        )
        .order_by(ServiceRequest.id.desc())
        .limit(max(1, min(limit, 80)))
    )
    login = _requester_login(identity.requester_name)
    if login:
        stmt = stmt.where(ServiceRequest.requester_name.ilike(_ilike_contains(login), escape="\\"))

    rows = list((await db.execute(stmt)).scalars().all())
    if not rows:
        return []

    request_ids = [row.id for row in rows]
    assignees: dict[int, list[str]] = {rid: [] for rid in request_ids}
    ar = await db.execute(
        select(service_request_assignees.c.request_id, User.full_name, User.username)
        .join(User, User.id == service_request_assignees.c.user_id)
        .where(service_request_assignees.c.request_id.in_(request_ids))
        .order_by(User.username.asc())
    )
    for request_id, full_name, username in ar.all():
        label = assignee_public_label(full_name, username)
        if label:
            assignees.setdefault(int(request_id), []).append(label)

    return [
        PublicTicket(
            id=row.id,
            ticket_no=row.ticket_no,
            title=row.title,
            status=row.status,
            assignees=summarize_public_assignees(assignees.get(row.id, [])),
            opened_at=row.opened_at or row.created_at,
            updated_at=row.updated_at,
            closed_at=row.closed_at,
        )
        for row in rows
    ]


async def _load_category_paths(db: AsyncSession) -> list[str]:
    from app.models import ServiceRequestCategory
    from app.request_categories_defaults import DEFAULT_REQUEST_CATEGORIES
    from app.request_category_tree import build_category_tree, collect_category_paths, insert_paths_into_session

    cnt = int(await db.scalar(select(func.count()).select_from(ServiceRequestCategory)) or 0)
    if cnt <= 0:
        await insert_paths_into_session(db, DEFAULT_REQUEST_CATEGORIES)
        await db.flush()
    rows = list(
        (
            await db.execute(
                select(ServiceRequestCategory).order_by(
                    ServiceRequestCategory.sort_order.asc(),
                    ServiceRequestCategory.name.asc(),
                )
            )
        ).scalars().all()
    )
    paths = collect_category_paths(build_category_tree(rows))
    return paths or list(DEFAULT_REQUEST_CATEGORIES)


_CATEGORY_RULES: list[tuple[tuple[str, ...], str]] = [
    (("картридж", "тонер", "замен"), "Принтеры и Сканеры > Замена картриджей"),
    (("замин", "бумаг"), "Принтеры и Сканеры > Замина бумаги"),
    (("принтер", "сканер", "мфу", "печать", "не печата"), "Принтеры и Сканеры > Прочее"),
    (("bitrix", "битрикс", "б24", "b24"), "Програмное обеспечение > Прочее ПО"),
    (("outlook", "почт", "отбивк"), "Програмное обеспечение > Outlook > Отбивка почты"),
    (("переадрес",), "Програмное обеспечение > Outlook > Переадресация"),
    (("outlook",), "Програмное обеспечение > Outlook"),
    (("rdp", "удаленн", "remote", "vpn", "citrix"), "Програмное обеспечение > Настройка удаленного рабочего места"),
    (("windows", "обновлен", "ос ", "операцион"), "Програмное обеспечение > Обновление ОС"),
    (("zoom", "teams", "trueconf", "видеоконферен", "презентац", "проектор"), "Видеоконференции и презентации"),
    (("интернет", "wifi", "wi-fi", "сеть", "кабель", "пинг"), "Связь > Проблемы с интернетом"),
    (("телефон", "атс", "voip", "трубк"), "Связь > Проблемы с телефонией"),
    (("монитор", "клавиатур", "мыш", "перифери", "наушник", "колонк"), "Оборудование > Проблемы с периферийными устройствами"),
    (("системн", "системный блок", "не включа", "синий экран", "bsod", "перезагруз"), "Оборудование > Проблемы с системным блоком"),
    (("установ", "доп. оборуд", "дополнительн"), "Оборудование > Установка доп. оборудования"),
    (("демонтаж",), "Организационные вопросы > демонтаж места сотрудника"),
    (("перенос", "переезд"), "Организационные вопросы > Перенос рабочего места"),
    (("новый сотрудник", "рабочее место для"), "Организационные вопросы > Рабочее место для нового сотрудника"),
    (("организац",), "Организационные вопросы"),
    (("програм", "софт", "office", "1с", "1c"), "Програмное обеспечение > Прочее ПО"),
]


def _match_path(candidate: str, paths: list[str]) -> str | None:
    c = (candidate or "").strip()
    if not c:
        return None
    low = c.lower()
    for p in paths:
        if p.lower() == low:
            return p
    for p in paths:
        if low in p.lower() or p.lower() in low:
            return p
    last = low.split(">")[-1].strip()
    for p in paths:
        if p.lower().split(">")[-1].strip() == last:
            return p
    return None


def classify_category_fast(title: str, description: str, paths: list[str]) -> str | None:
    text = f"{title}\n{description}".lower()
    for keys, preferred in _CATEGORY_RULES:
        if any(k in text for k in keys):
            hit = _match_path(preferred, paths)
            if hit:
                return hit
            pref_root = preferred.split(">")[0].strip().lower()
            for p in paths:
                if p.lower().startswith(pref_root):
                    return p
    return None


def extract_category_from_llm(parsed: dict[str, Any], answer: str, paths: list[str]) -> str | None:
    for key in ("category", "category_path", "категория"):
        raw = parsed.get(key)
        if isinstance(raw, str):
            hit = _match_path(raw, paths)
            if hit:
                return hit
    m = re.search(r"(?im)^\s*(?:category|категория)\s*[:：]\s*(.+)\s*$", answer or "")
    if m:
        hit = _match_path(m.group(1), paths)
        if hit:
            return hit
    return None


def extract_title_suggestion(parsed: dict[str, Any], *, current_title: str) -> str | None:
    for key in ("title_suggestion", "suggested_title", "title", "тема"):
        raw = parsed.get(key)
        if isinstance(raw, str):
            s = raw.strip()
            if s and s.lower() != (current_title or "").strip().lower():
                return s[:255]
    return None


def resolve_ticket_category(
    *,
    title: str,
    description: str,
    paths: list[str],
    parsed: dict[str, Any] | None,
    answer: str,
    fallback: str | None,
) -> str:
    paths = paths or []
    if parsed:
        hit = extract_category_from_llm(parsed, answer, paths)
        if hit:
            return hit
    hit = classify_category_fast(title, description, paths)
    if hit:
        return hit
    if fallback:
        hit = _match_path(fallback, paths)
        if hit:
            return hit
        if fallback.strip().lower() not in {"ticket-handler", "ticket_handler", "handler"}:
            return fallback.strip()[:255]
    for preferred in (
        "Програмное обеспечение > Прочее ПО",
        "Принтеры и Сканеры > Прочее",
        "Организационные вопросы",
    ):
        hit = _match_path(preferred, paths)
        if hit:
            return hit
    return (paths[-1] if paths else "Програмное обеспечение > Прочее ПО")[:255]


async def _create_service_request(
    db: AsyncSession,
    *,
    cfg: TicketHandlerConfig,
    computer: Computer | None,
    hostname: str,
    title: str,
    description: str,
    requester_name: str | None,
    category: str | None,
) -> ServiceRequest:
    bot = await _bot_user(db)
    now = datetime.now(timezone.utc)
    status = normalize_intake_status(cfg.default_status)
    priority = (cfg.default_priority or "normal").strip() or "normal"
    cat = (category or "").strip() or None
    label = (requester_name or "").strip()
    loc = (computer.location or "").strip() if computer is not None else ""
    row = ServiceRequest(
        title=title.strip()[:255],
        description=(description.strip()[:10_000] or None),
        status=status[:64],
        priority=priority[:32],
        requester_name=label[:255] or None,
        category=cat[:255] if cat else None,
        location=loc[:255] or None,
        computer_id=computer.id if computer else None,
        created_by_id=bot.id,
        opened_at=now,
        external_source="ticket_handler",
        external_id=(computer.hostname if computer else hostname)[:255] or None,
    )
    db.add(row)
    await db.flush()
    await ensure_ticket_no(db, row)
    support_user_ids = (
        await db.execute(
            select(User.id).where(
                User.is_active.is_(True),
                User.is_ldap.is_(False),
                or_(User.is_superuser.is_(True), func.lower(User.role) == "editor"),
            )
        )
    ).scalars().all()
    for user_id in support_user_ids:
        await db.execute(
            service_request_assignees.insert().values(request_id=row.id, user_id=int(user_id))
        )
    await index_service_request(db, row)
    return row


async def classify_with_llm(
    *,
    cfg: TicketHandlerConfig,
    title: str,
    description: str,
    paths: list[str],
    fast_category: str | None,
) -> tuple[dict[str, Any], str | None, str | None]:
    """Returns (parsed, model_name, error)."""
    cats_block = "\n".join(f"- {p}" for p in paths[:80])
    user_content = (
        "## Заявка\n"
        f"Тема: {title}\n"
        f"Описание: {description or '—'}\n\n"
        "## Категории CORAX (выбери ровно одну строку)\n"
        f"{cats_block}\n\n"
        "Верни JSON без markdown:\n"
        '{"category":"<точная строка из списка>","title_suggestion":"<краткая тема>"}\n'
        + (f"Подсказка правил: {fast_category}\n" if fast_category else "")
    )
    system = (cfg.system_prompt or "").strip() or CLASSIFY_SYSTEM
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]
    try:
        raw, used_model = await lm_studio_chat(
            messages,
            base_url=(cfg.llm_base_url or "").strip() or None,
            model=(cfg.llm_model or "").strip() or None,
            mode="rag",
            response_mode="fast",
        )
        parsed = coerce_parsed(raw)
        if not isinstance(parsed, dict):
            parsed = {}
        return parsed, used_model, None
    except Exception as exc:  # noqa: BLE001
        return {}, None, str(exc)


async def enrich_service_request(
    db: AsyncSession,
    *,
    cfg: TicketHandlerConfig,
    request_id: int,
    persist: bool = True,
) -> EnrichResult:
    row = await db.get(ServiceRequest, request_id)
    if row is None:
        return EnrichResult(ok=False, error_detail="Заявка не найдена")

    title = (row.title or "").strip()
    description = (row.description or "").strip()
    try:
        paths = await _load_category_paths(db)
    except Exception as exc:  # noqa: BLE001
        from app.request_categories_defaults import DEFAULT_REQUEST_CATEGORIES

        paths = list(DEFAULT_REQUEST_CATEGORIES)
        logger.warning("category paths fallback: %s", exc)

    fast = classify_category_fast(title, description, paths)
    parsed, model, llm_error = await classify_with_llm(
        cfg=cfg,
        title=title,
        description=description,
        paths=paths,
        fast_category=fast,
    )
    category = resolve_ticket_category(
        title=title,
        description=description,
        paths=paths,
        parsed=parsed,
        answer="",
        fallback=(cfg.default_category or "").strip() or None,
    )
    suggestion = extract_title_suggestion(parsed, current_title=title)

    meta = {
        "category": category,
        "title_suggestion": suggestion,
        "fast_category": fast,
        "model": model,
        "llm_error": llm_error,
    }

    if persist:
        row.category = category
        if suggestion:
            row.ai_title_suggestion = suggestion
        row.ai_enriched_at = datetime.now(timezone.utc)
        await index_service_request(db, row)
        await db.commit()

    return EnrichResult(
        ok=llm_error is None or bool(category),
        category=category,
        title_suggestion=suggestion,
        model=model,
        error_detail=llm_error,
        meta=meta,
    )


async def enrich_ticket_ai_task(request_id: int) -> None:
    """Background job: open a fresh DB session and classify the ticket."""
    from app.database import AsyncSessionLocal

    try:
        async with AsyncSessionLocal() as db:
            cfg = await db.scalar(select(TicketHandlerConfig).where(TicketHandlerConfig.id == 1).limit(1))
            if cfg is None:
                return
            pipeline = _parse_pipeline(cfg.pipeline_json)
            if not _step_enabled(pipeline, "classify") and not _step_enabled(pipeline, "llm"):
                row = await db.get(ServiceRequest, request_id)
                if row is None:
                    return
                paths = await _load_category_paths(db)
                cat = classify_category_fast(row.title or "", row.description or "", paths)
                if not cat:
                    cat = resolve_ticket_category(
                        title=row.title or "",
                        description=row.description or "",
                        paths=paths,
                        parsed=None,
                        answer="",
                        fallback=(cfg.default_category or "").strip() or None,
                    )
                row.category = cat
                row.ai_enriched_at = datetime.now(timezone.utc)
                await index_service_request(db, row)
                await db.commit()
                return
            await enrich_service_request(db, cfg=cfg, request_id=request_id, persist=True)
    except Exception:  # noqa: BLE001
        logger.exception("ticket AI enrich failed for request_id=%s", request_id)


async def run_intake(db: AsyncSession, cfg: TicketHandlerConfig, payload: IntakeInput) -> IntakeResult:
    started = time.perf_counter()
    title = (payload.title or "").strip()
    description = (payload.description or "").strip()

    identity = await resolve_client_identity(
        db,
        hostname_hint=payload.hostname,
        client_ip=payload.client_ip,
        sso_login=payload.sso_login,
    )
    computer = identity.computer
    hostname = identity.hostname
    requester_name = identity.requester_name

    category_paths: list[str] = []
    try:
        category_paths = await _load_category_paths(db)
    except Exception as exc:  # noqa: BLE001
        from app.request_categories_defaults import DEFAULT_REQUEST_CATEGORIES

        category_paths = list(DEFAULT_REQUEST_CATEGORIES)
        logger.warning("categories load: %s", exc)

    fast_category = classify_category_fast(title, description, category_paths)
    provisional = fast_category
    if not provisional and (cfg.default_category or "").strip():
        provisional = resolve_ticket_category(
            title=title,
            description=description,
            paths=category_paths,
            parsed=None,
            answer="",
            fallback=(cfg.default_category or "").strip() or None,
        )

    # Ticket-first: create when auto_create is on (product default).
    create = bool(cfg.auto_create_ticket)

    request_id: int | None = None
    ticket_no: int | None = None
    status = "ok"
    error_detail: str | None = None
    schedule_enrich_id: int | None = None
    dry_meta: dict[str, Any] = {}

    if create:
        if payload.dry_run:
            status = "created_ticket"
            parsed, model, llm_error = await classify_with_llm(
                cfg=cfg,
                title=title,
                description=description,
                paths=category_paths,
                fast_category=fast_category,
            )
            category = resolve_ticket_category(
                title=title,
                description=description,
                paths=category_paths,
                parsed=parsed,
                answer="",
                fallback=(cfg.default_category or "").strip() or None,
            )
            suggestion = extract_title_suggestion(parsed, current_title=title)
            dry_meta = {
                "category": category,
                "title_suggestion": suggestion,
                "fast_category": fast_category,
                "model": model,
                "llm_error": llm_error,
                "dry_run": True,
            }
        else:
            try:
                row = await _create_service_request(
                    db,
                    cfg=cfg,
                    computer=computer,
                    hostname=hostname,
                    title=title,
                    description=description,
                    requester_name=requester_name,
                    category=provisional,
                )
                request_id = row.id
                ticket_no = row.ticket_no
                status = "created_ticket"
                schedule_enrich_id = row.id
            except Exception as exc:  # noqa: BLE001
                await db.rollback()
                status = "error"
                error_detail = f"ticket: {exc}"
    else:
        status = "skipped_ticket"

    latency_ms = int((time.perf_counter() - started) * 1000)
    meta: dict[str, Any] = {
        "dry_run": payload.dry_run,
        "computer_id": computer.id if computer else None,
        "create": create,
        "fast_category": fast_category,
        "provisional_category": provisional,
        **dry_meta,
    }
    if error_detail:
        meta["error"] = error_detail

    if status == "created_ticket" and not payload.dry_run:
        answer = f"Заявка принята{f', №{ticket_no}' if ticket_no else ''}."
    elif payload.dry_run:
        answer = f"[dry-run] Категория: {dry_meta.get('category') or provisional or '—'}"
    else:
        answer = "Обращение принято."

    run_id: int | None = None
    model_name = dry_meta.get("model") if isinstance(dry_meta.get("model"), str) else None
    if payload.dry_run:
        await db.rollback()
    else:
        run = TicketHandlerRun(
            status=status,
            latency_ms=latency_ms,
            hostname=hostname or None,
            requester_name=requester_name,
            service_request_id=request_id,
            error_detail=error_detail,
            meta_json=json.dumps(meta, ensure_ascii=False),
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
        run_id = run.id

    return IntakeResult(
        ok=status != "error",
        answer=answer,
        status=status,
        run_id=run_id,
        request_id=request_id,
        ticket_no=ticket_no,
        latency_ms=latency_ms,
        hostname=hostname or None,
        requester_name=requester_name,
        model=model_name,
        error_detail=error_detail,
        dry_run=payload.dry_run,
        meta=meta,
        schedule_enrich_id=schedule_enrich_id,
    )
