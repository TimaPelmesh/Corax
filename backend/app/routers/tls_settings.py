"""HTTPS / local CA settings (superuser only)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.auth import get_current_superuser
from app.models import User
from app import tls_certs

router = APIRouter(prefix="/settings/tls", tags=["tls"])


class TlsStatusOut(BaseModel):
    enabled: bool
    active: bool
    files_ready: bool
    ca_ready: bool
    hostnames: list[str] = []
    not_after: str | None = None
    fingerprint_sha256: str | None = None
    generated_at: str | None = None
    restart_required: bool = False
    dev_blocked: bool = False
    tls_dir: str = ""


class TlsGenerateIn(BaseModel):
    hostnames: list[str] = Field(min_length=1, max_length=32)
    days: int = Field(default=825, ge=1, le=3650)
    rotate_ca: bool = False


class TlsEnableIn(BaseModel):
    enabled: bool


@router.get("", response_model=TlsStatusOut)
async def get_tls_status(_: User = Depends(get_current_superuser)):
    return TlsStatusOut(**tls_certs.status())


@router.post("/generate", response_model=TlsStatusOut)
async def generate_tls(body: TlsGenerateIn, _: User = Depends(get_current_superuser)):
    try:
        return TlsStatusOut(**tls_certs.generate(body.hostnames, days=body.days, rotate_ca=body.rotate_ca))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Не удалось записать сертификаты: {e}") from e


@router.post("/enable", response_model=TlsStatusOut)
async def enable_tls(body: TlsEnableIn, _: User = Depends(get_current_superuser)):
    try:
        return TlsStatusOut(**tls_certs.set_enabled(body.enabled))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/ca.crt")
async def download_ca(_: User = Depends(get_current_superuser)):
    try:
        pem = tls_certs.ca_pem()
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return Response(
        content=pem,
        media_type="application/x-x509-ca-cert",
        headers={"Content-Disposition": 'attachment; filename="corax-local-ca.crt"'},
    )
