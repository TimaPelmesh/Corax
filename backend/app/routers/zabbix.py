"""Read-only Zabbix data for panel users (scope B + knowledge base)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.models import User
from app.zabbix_service import (
    get_host_status_payload,
    get_hosts_payload,
    get_overview_payload,
    get_problems_payload,
)

router = APIRouter(prefix="/zabbix", tags=["zabbix"])


@router.get("/overview")
async def zabbix_overview(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_overview_payload(db)


@router.get("/problems")
async def zabbix_problems(
    limit: int = Query(50, ge=1, le=200),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_problems_payload(db, limit=limit)


@router.get("/hosts")
async def zabbix_hosts(
    limit: int = Query(100, ge=1, le=500),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_hosts_payload(db, limit=limit)


@router.get("/host-status")
async def zabbix_host_status(
    hostname: str = Query(..., min_length=1, max_length=255),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_host_status_payload(db, hostname)
