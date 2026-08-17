import secrets
from datetime import datetime, timezone
import hashlib
import hmac

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_superuser
from app.config import settings
from app.database import get_db
from app.models import AgentToken, User
from app.schemas import AgentTokenCreate, AgentTokenCreated, AgentTokenOut

router = APIRouter(prefix="/agent-tokens", tags=["agent-tokens"])

_AGENT_TOKEN_PREFIX = "hmac256:"


def _hmac_secret(secret: str) -> str:
    key = (settings.agent_token_pepper or settings.secret_key).encode("utf-8")
    return hmac.new(key, secret.encode("utf-8"), hashlib.sha256).hexdigest()


@router.get("", response_model=list[AgentTokenOut])
async def list_agent_tokens(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(AgentToken).order_by(AgentToken.id.desc()))
    return list(r.scalars().all())


@router.post("", response_model=AgentTokenCreated)
async def create_agent_token(
    body: AgentTokenCreate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    public_id = secrets.token_hex(4)
    secret = secrets.token_urlsafe(24)
    token = f"{public_id}.{secret}"
    row = AgentToken(
        public_id_prefix=public_id,
        token_hash=_AGENT_TOKEN_PREFIX + _hmac_secret(secret),
        label=body.label,
        allowed_hostname=body.allowed_hostname,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return AgentTokenCreated(
        id=row.id,
        public_id_prefix=row.public_id_prefix,
        label=row.label,
        allowed_hostname=row.allowed_hostname,
        created_at=row.created_at,
        revoked_at=row.revoked_at,
        last_used_at=row.last_used_at,
        token=token,
    )


@router.delete("/{token_id}", status_code=204)
async def revoke_agent_token(
    token_id: int,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(AgentToken, token_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Токен не найден")
    row.revoked_at = datetime.now(timezone.utc)
    await db.commit()
