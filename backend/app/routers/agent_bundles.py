from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_bundle import build_agent_bundle_zip
from app.agent_exe import build_agent_exe_for_request, exe_build_available
from app.auth import get_current_superuser
from app.database import get_db
from app.models import User
from app.local_ip import list_lan_ipv4, pick_primary_lan_ipv4
from app.schemas import AgentBundleCreate, AgentBundleLanIpOut, AgentExeCreate, AgentExeStatusOut

router = APIRouter(prefix="/agent-bundles", tags=["agent-bundles"])


@router.get("/lan-ip", response_model=AgentBundleLanIpOut)
async def agent_bundle_lan_ip(_: User = Depends(get_current_superuser)):
    """Локальный LAN IPv4 сервера CORAX (для подстановки в сборку агента)."""
    candidates = list_lan_ipv4()
    return AgentBundleLanIpOut(ip=pick_primary_lan_ipv4(), candidates=candidates)


@router.get("/exe/status", response_model=AgentExeStatusOut)
async def agent_exe_status(_: User = Depends(get_current_superuser)):
    """Проверка: можно ли собрать .exe на этом сервере."""
    ok, reason = exe_build_available()
    return AgentExeStatusOut(available=ok, reason=reason)


@router.post("/exe")
async def create_agent_exe(
    body: AgentExeCreate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Собрать автономный CORAX-Agent.exe (Win10/11, PyInstaller onefile)."""
    try:
        data, filename = await build_agent_exe_for_request(db, body)
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
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return Response(
        content=data,
        media_type="application/vnd.microsoft.portable-executable",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.post("")
async def create_agent_bundle(
    body: AgentBundleCreate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Собрать ZIP с CORAX Agent v3 (Win10) для размещения на файловой шаре."""
    try:
        data, filename = await build_agent_bundle_zip(db, body)
    except FileNotFoundError as exc:
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

    return Response(
        content=data,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )
