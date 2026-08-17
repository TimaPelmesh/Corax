import ipaddress
import json
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import hash_password
from app.routers.agent import _reported_assigned_user
from app.config import settings
from app.database import get_db
from app.models import Computer, ServiceRequest, User, service_request_assignees
from app.rate_limit import limiter
from app.request_categories_defaults import DEFAULT_REQUEST_CATEGORIES
from app.schemas import SelfServiceContextOut, SelfServiceRequestCreate, SelfServiceRequestOut
from app.search_index import index_service_request
from app.service_request_tickets import ensure_ticket_no

router = APIRouter(prefix="/self-service", tags=["self-service"])


def _require_lan(request: Request) -> None:
    if not settings.self_service_enabled and settings.environment != "test":
        raise HTTPException(status_code=404, detail="Self-service is disabled")
    host = request.client.host if request.client else ""
    if settings.environment == "test":
        return
    try:
        if not ipaddress.ip_address(host).is_private:
            raise HTTPException(status_code=403, detail="Доступ только из локальной сети")
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Не удалось определить адрес клиента") from exc


async def _computer(db: AsyncSession, hostname: str) -> Computer:
    normalized = hostname.strip()
    row = await db.scalar(select(Computer).where(func.lower(Computer.hostname) == normalized.lower()).limit(1))
    if row is None or row.last_report_at is None:
        raise HTTPException(status_code=404, detail="ПК не найден в актуальном инвентаре")
    return row


async def _bot_user(db: AsyncSession) -> User:
    row = await db.scalar(select(User).where(User.username == "self-service-bot").limit(1))
    if row:
        return row
    row = User(
        username="self-service-bot",
        full_name="CORAX Self-Service",
        hashed_password=hash_password(secrets.token_urlsafe(24)),
        is_active=True,
        is_superuser=False,
        is_ldap=False,
        role="directory",
    )
    db.add(row)
    await db.flush()
    return row


@router.get("/context", response_model=SelfServiceContextOut)
async def context(
    request: Request,
    hostname: str = Query(..., min_length=1, max_length=255),
    db: AsyncSession = Depends(get_db),
):
    _require_lan(request)
    computer = await _computer(db, hostname)
    return SelfServiceContextOut(
        hostname=computer.hostname,
        computer_id=computer.id,
        location=None,
        categories=list(DEFAULT_REQUEST_CATEGORIES),
    )


@router.post("/requests", response_model=SelfServiceRequestOut)
@limiter.limit(settings.rate_limit_self_service)
async def create_request(
    request: Request,
    body: SelfServiceRequestCreate = Body(...),
    db: AsyncSession = Depends(get_db),
):
    _require_lan(request)
    computer = await _computer(db, body.hostname)
    assigned_user = await db.get(User, computer.assigned_user_id) if computer.assigned_user_id else None
    if assigned_user is None and computer.raw_payload:
        try:
            payload = json.loads(computer.raw_payload)
            extended = payload.get("extended") if isinstance(payload, dict) else None
        except json.JSONDecodeError:
            extended = None
        assigned_user = await _reported_assigned_user(db, extended if isinstance(extended, dict) else None)
        if assigned_user is not None:
            computer.assigned_user_id = assigned_user.id
    requester_name = (
        (assigned_user.full_name or assigned_user.username).strip()
        if assigned_user is not None
        else f"ПК {computer.hostname}"
    )
    bot = await _bot_user(db)
    now = datetime.now(timezone.utc)
    row = ServiceRequest(
        title=body.title.strip(),
        description=(body.description or "").strip() or None,
        status="open",
        priority="normal",
        requester_name=requester_name,
        category=(body.category or settings.self_service_default_category).strip()[:255],
        location=None,
        computer_id=computer.id,
        created_by_id=bot.id,
        opened_at=now,
        planned_close_at=body.planned_close_at,
        external_source="self_service",
        external_id=computer.hostname,
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
    await db.commit()
    return SelfServiceRequestOut(request_id=row.id, ticket_no=row.ticket_no)
