"""LAN-only installer pairing. The EXE announces; an admin approves; the token is claimed once."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_superuser
from app.config import settings
from app.database import get_db
from app.models import AgentPairing, AgentToken, User
from app.net_trust import is_private_ip
from app.ticket_client_identity import client_ip

router = APIRouter(prefix="/agent", tags=["agent-pair"])
admin_router = APIRouter(prefix="/agent-tokens", tags=["agent-pair"])

_AGENT_TOKEN_PREFIX = "hmac256:"


def _hmac_secret(secret: str) -> str:
    key = (settings.agent_token_pepper or settings.secret_key).encode("utf-8")
    return hmac.new(key, secret.encode("utf-8"), hashlib.sha256).hexdigest()


def _lan_only(request: Request) -> None:
    ip = client_ip(request)
    if is_private_ip(ip):
        return
    try:
        if ipaddress.ip_address(ip).is_loopback:
            return
    except ValueError:
        pass
    raise HTTPException(status_code=403, detail="Подключение агента доступно только в локальной сети")


class PairAnnounce(BaseModel):
    public_id: str = Field(min_length=16, max_length=64)
    hostname: str = Field(default="", max_length=255)


class PairClaim(BaseModel):
    public_id: str = Field(min_length=16, max_length=64)


class PairingOut(BaseModel):
    id: int
    hostname: str
    status: str
    created_at: datetime


@router.get("/discover")
async def discover_server(request: Request):
    _lan_only(request)
    return {"product": "corax"}


@router.post("/pair/announce")
async def announce_pairing(body: PairAnnounce, request: Request, db: AsyncSession = Depends(get_db)):
    _lan_only(request)
    public_id = body.public_id.strip()
    hostname = body.hostname.strip()[:255]
    row = (
        await db.execute(select(AgentPairing).where(AgentPairing.public_id == public_id))
    ).scalar_one_or_none()
    if row is None:
        row = AgentPairing(public_id=public_id, hostname=hostname, status="pending")
        db.add(row)
    elif row.status == "pending":
        row.hostname = hostname or row.hostname
    await db.commit()
    await db.refresh(row)
    return {"status": row.status}


@router.post("/pair/claim")
async def claim_pairing(body: PairClaim, request: Request, db: AsyncSession = Depends(get_db)):
    _lan_only(request)
    row = (
        await db.execute(select(AgentPairing).where(AgentPairing.public_id == body.public_id.strip()))
    ).scalar_one_or_none()
    if row is None or row.status != "approved" or not row.token_once:
        return {"status": "pending"}
    token = row.token_once
    row.token_once = None
    row.status = "claimed"
    await db.commit()
    return {"status": "claimed", "agent_token": token}


@admin_router.get("/pair/pending", response_model=list[PairingOut])
async def list_pending_pairings(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(AgentPairing)
            .where(AgentPairing.status == "pending")
            .order_by(AgentPairing.id.desc())
        )
    ).scalars().all()
    return [
        PairingOut(id=row.id, hostname=row.hostname or "—", status=row.status, created_at=row.created_at)
        for row in rows
    ]


@admin_router.post("/pair/{pairing_id}/approve", response_model=PairingOut)
async def approve_pairing(
    pairing_id: int,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(AgentPairing, pairing_id)
    if row is None or row.status != "pending":
        raise HTTPException(status_code=404, detail="Установщик не найден")
    public_id = secrets.token_hex(4)
    secret = secrets.token_urlsafe(24)
    token = f"{public_id}.{secret}"
    host = (row.hostname or "").strip()[:255] or None
    db.add(
        AgentToken(
            public_id_prefix=public_id,
            token_hash=_AGENT_TOKEN_PREFIX + _hmac_secret(secret),
            label=f"Установщик {host or row.id}",
            allowed_hostname=host,
        )
    )
    row.status = "approved"
    row.token_once = token
    await db.commit()
    await db.refresh(row)
    return PairingOut(id=row.id, hostname=row.hostname or "—", status=row.status, created_at=row.created_at)
