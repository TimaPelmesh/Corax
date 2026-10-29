"""Settings status, the overnight feed, and the GLPI followup/license reads."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_editor_or_superuser, get_current_superuser, get_current_user
from app.backup_schedule import ensure_schedule, schedule_view
from app.database import WarehouseSessionLocal, get_db
from app.glpi_client import GlpiClientError, fetch_followups, fetch_licenses
from app.glpi_sync import creds_from_row
from app.models import (
    AgentToken,
    Bitrix24Config,
    Computer,
    GlpiConfig,
    LdapConfig,
    ServiceRequest,
    User,
    WakeOnLanConfig,
    ZabbixConfig,
)
from app.pg_backup import pg_tools_status
from app.product_depth import night_feed, overdue_reason, settings_board
from app.tls_certs import status as tls_status
from app.warehouse_models import StockItem
from app.wikirag_options import get_llm_servers

router = APIRouter(tags=["product-signals"])

_SILENT_DAYS = 7


def _iso_cert(raw: object) -> datetime | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment


@router.get("/settings/board")
async def settings_connection_board(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    ldap = (await db.execute(select(LdapConfig).limit(1))).scalar_one_or_none()
    bitrix = (await db.execute(select(Bitrix24Config).limit(1))).scalar_one_or_none()
    zabbix = (await db.execute(select(ZabbixConfig).limit(1))).scalar_one_or_none()
    glpi = (await db.execute(select(GlpiConfig).limit(1))).scalar_one_or_none()
    wol = (await db.execute(select(WakeOnLanConfig).limit(1))).scalar_one_or_none()
    tokens = int(
        await db.scalar(select(func.count()).select_from(AgentToken).where(AgentToken.revoked_at.is_(None))) or 0
    )
    silent_cutoff = now - timedelta(days=_SILENT_DAYS)
    silent = int(
        await db.scalar(
            select(func.count())
            .select_from(AgentToken)
            .where(
                AgentToken.revoked_at.is_(None),
                or_(AgentToken.last_used_at.is_(None), AgentToken.last_used_at < silent_cutoff),
            )
        )
        or 0
    )
    try:
        servers = len(get_llm_servers())
    except Exception:
        servers = 0
    try:
        tools = pg_tools_status()
        pg_dump = bool(tools.get("pg_dump_available"))
    except Exception:
        pg_dump = False
    try:
        https = tls_status()
    except Exception:
        https = {}
    schedule = await ensure_schedule(db)
    view = schedule_view(schedule, now)
    facts = {
        "ldap_enabled": bool(ldap and ldap.enabled),
        "ldap_configured": bool(ldap and (ldap.uri or "").strip()),
        "bitrix_enabled": bool(bitrix and bitrix.bot_id and (bitrix.bot_webhook_url or "").strip()),
        "bitrix_configured": bool(bitrix and bitrix.bot_id and (bitrix.bot_webhook_url or "").strip()),
        "bitrix_paused": bool(bitrix and bitrix.bot_paused),
        "zabbix_enabled": bool(zabbix and zabbix.enabled),
        "zabbix_configured": bool(zabbix and (zabbix.base_url or "").strip() and (zabbix.api_token or "").strip()),
        "zabbix_last_ok": None if zabbix is None else zabbix.last_test_ok,
        "zabbix_checked_at": None if zabbix is None else zabbix.last_test_at,
        "glpi_enabled": bool(glpi and glpi.enabled),
        "glpi_configured": bool(glpi and (glpi.base_url or "").strip()),
        "glpi_last_ok": None if glpi is None else glpi.last_test_ok,
        "glpi_checked_at": None if glpi is None else glpi.last_test_at,
        "llm_servers": servers,
        "pg_dump": pg_dump,
        "backup_due": bool(view["due"]),
        "agent_tokens": tokens,
        "agent_silent": silent,
        "wol_enabled": bool(wol and wol.enabled),
        "https_enabled": bool(https.get("enabled")),
        "https_not_after": _iso_cert(https.get("not_after")),
    }
    return {"items": settings_board(facts, now)}


@router.get("/dashboard/overnight")
async def dashboard_overnight(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    now = datetime.now(timezone.utc)
    offline_rows = (
        await db.execute(
            select(Computer.hostname)
            .where(Computer.ping_status == "offline")
            .order_by(Computer.last_ping_at.desc().nullslast(), Computer.id.desc())
            .limit(8)
        )
    ).all()
    tickets = (
        await db.execute(
            select(ServiceRequest)
            .where(ServiceRequest.status.in_(("open", "in_progress")))
            .order_by(ServiceRequest.id.desc())
            .limit(200)
        )
    ).scalars()
    overdue = []
    for ticket in tickets:
        reason = overdue_reason(ticket.priority, ticket.opened_at or ticket.created_at, ticket.planned_close_at, now)
        if not reason:
            continue
        overdue.append({"id": ticket.id, "title": ticket.title, "reason": reason})
        if len(overdue) >= 8:
            break
    stock: list[dict] = []
    try:
        async with WarehouseSessionLocal() as warehouse:
            found = await warehouse.execute(
                select(StockItem.name, StockItem.quantity_available)
                .where(StockItem.quantity_available <= 2)
                .order_by(StockItem.quantity_available)
                .limit(8)
            )
            stock = [{"name": name, "available": int(available or 0)} for name, available in found.all()]
    except Exception:
        stock = []
    return {
        "items": night_feed(
            offline=[{"hostname": hostname} for (hostname,) in offline_rows],
            tickets=overdue,
            stock=stock,
        )
    }


async def _glpi_creds(db: AsyncSession):
    row = (await db.execute(select(GlpiConfig).limit(1))).scalar_one_or_none()
    if row is None or not row.enabled or not (row.base_url or "").strip():
        return None
    return creds_from_row(row)


@router.get("/settings/glpi/followups/{ticket_id}")
async def glpi_followups(
    ticket_id: int,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    creds = await _glpi_creds(db)
    if creds is None:
        return {"available": False, "items": []}
    try:
        items = await asyncio.to_thread(fetch_followups, creds, ticket_id)
    except GlpiClientError as exc:
        return {"available": True, "items": [], "error": str(exc)[:300]}
    return {"available": True, "items": items}


@router.get("/settings/glpi/licenses")
async def glpi_licenses(_: User = Depends(get_current_superuser), db: AsyncSession = Depends(get_db)):
    creds = await _glpi_creds(db)
    if creds is None:
        return {"available": False, "items": []}
    try:
        items = await asyncio.to_thread(fetch_licenses, creds)
    except GlpiClientError as exc:
        return {"available": True, "items": [], "error": str(exc)[:300]}
    return {"available": True, "items": items}
