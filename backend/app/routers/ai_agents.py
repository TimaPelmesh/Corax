"""AI agent settings: endpoints + per-purpose roles."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_agents import (
    AI_PURPOSES,
    endpoint_out,
    list_endpoints,
    list_roles,
    replace_endpoints,
    resolve_ai,
    role_out,
    upsert_role,
)
from app.auth import get_current_editor_or_superuser, require_user
from app.database import get_db
from app.models import User  # noqa: F401 — type for Depends

router = APIRouter(prefix="/ai-agents", tags=["ai-agents"])


class AiEndpointIn(BaseModel):
    id: str | None = Field(default=None, max_length=16)
    key: str | None = Field(default=None, max_length=16)
    label: str = Field(default="", max_length=64)
    base_url: str = Field(min_length=1, max_length=512)
    enabled: bool = True
    notes: str | None = None


class AiEndpointsReplace(BaseModel):
    endpoints: list[AiEndpointIn] = Field(default_factory=list)


class AiRolePatch(BaseModel):
    endpoint_key: str | None = Field(default=None, max_length=16)
    model: str | None = Field(default=None, max_length=255)
    system_prompt: str | None = Field(default=None, max_length=8000)
    enabled: bool | None = None


@router.get("/bundle")
async def ai_agents_bundle(_: User = Depends(require_user), db: AsyncSession = Depends(get_db)):
    endpoints = await list_endpoints(db)
    roles = await list_roles(db)
    resolved = {purpose: await resolve_ai(db, purpose) for purpose in AI_PURPOSES}
    return {
        "purposes": list(AI_PURPOSES),
        "endpoints": [endpoint_out(row) for row in endpoints],
        "roles": [role_out(row, resolved.get(row.purpose)) for row in roles],
    }


@router.put("/endpoints")
async def put_endpoints(
    body: AiEndpointsReplace,
    user: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    try:
        rows = await replace_endpoints(
            db,
            [
                {
                    "key": item.key or item.id,
                    "label": item.label,
                    "base_url": item.base_url,
                    "enabled": item.enabled,
                    "notes": item.notes,
                }
                for item in body.endpoints
            ],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _ = user
    return {"endpoints": [endpoint_out(row) for row in rows]}


@router.patch("/roles/{purpose}")
async def patch_role(
    purpose: str,
    body: AiRolePatch,
    user: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    try:
        row = await upsert_role(
            db,
            purpose=purpose,
            endpoint_key=body.endpoint_key if "endpoint_key" in body.model_fields_set else None,
            model=body.model if "model" in body.model_fields_set else None,
            system_prompt=body.system_prompt if "system_prompt" in body.model_fields_set else None,
            enabled=body.enabled if "enabled" in body.model_fields_set else None,
        )
        resolved = await resolve_ai(db, purpose)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _ = user
    return role_out(row, resolved)
