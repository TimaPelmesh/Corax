from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_bundle import build_agent_bundle_zip
from app.auth import get_current_superuser
from app.database import get_db
from app.local_ip import advertise_lan_ipv4, list_lan_ipv4, pick_primary_lan_ipv4, _private_ipv4
from app.models import User
from app.schemas import AgentBundleCreate, AgentBundleLanIpOut

router = APIRouter(prefix="/agent-bundles", tags=["agent-bundles"])


def _host_header_lan_ip(request: Request) -> str | None:
    """If the admin opened the panel via http://192.168.x.x:3000, that Host is the agent target."""
    raw = (request.headers.get("host") or "").strip()
    if not raw:
        return None
    host = raw.rsplit(":", 1)[0].strip().strip("[]")
    if _private_ipv4(host):
        return host
    return None


@router.get("/lan-ip", response_model=AgentBundleLanIpOut)
async def agent_bundle_lan_ip(
    request: Request,
    _: User = Depends(get_current_superuser),
):
    """LAN IPv4 for agent bundle defaults. Never auto-picks Docker bridge (172.17–24.x)."""
    advertised = advertise_lan_ipv4()
    from_host = _host_header_lan_ip(request)
    detected = list_lan_ipv4(include_container_bridges=False)

    preferred = advertised or from_host or pick_primary_lan_ipv4()
    # Do not list container bridges as candidates — they look "valid" and break agent deploys.
    candidates: list[str] = []
    for ip in (preferred, from_host, *detected):
        if ip and ip not in candidates:
            candidates.append(ip)
    return AgentBundleLanIpOut(ip=preferred, candidates=candidates)


@router.post("")
async def create_agent_bundle(
    body: AgentBundleCreate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Собрать агент: ZIP (PowerShell win10/win7) или чистый EXE (cpp)."""
    try:
        data, filename = await build_agent_bundle_zip(db, body)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                "Не удалось создать токен агента (сбой id в PostgreSQL после миграции). "
                "Перезапустите API или выполните: python scripts/fix_pg_sequences.py"
            ),
        ) from exc

    media = (
        "application/vnd.microsoft.portable-executable"
        if filename.lower().endswith(".exe")
        else "application/zip"
    )
    return Response(
        content=data,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )
