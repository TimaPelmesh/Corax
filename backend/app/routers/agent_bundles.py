from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_bundle import _resolve_agent_token, build_agent_bundle_zip
from app.auth import get_current_superuser
from app.database import get_db
from app.linux_install import InstallError, installer_source, one_command, push_over_ssh
from app.local_ip import advertise_lan_ipv4, list_lan_ipv4, pick_primary_lan_ipv4, _private_ipv4
from app.models import User
from app.schemas import AgentBundleCreate, AgentBundleLanIpOut, LinuxSshInstallIn, WindowsWinrmInstallIn
from app.windows_install import (
    WindowsInstallError,
    discard_windows_exe,
    push_over_smb,
    push_over_winrm,
    stage_windows_exe,
)

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
    """Собрать агент: один Windows EXE (токен внутри) или ZIP Linux."""
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


async def _linux_token(db: AsyncSession, body: AgentBundleCreate) -> str:
    prepared = body.model_copy(update={"target": "linux", "create_token": True})
    try:
        token, _created = await _resolve_agent_token(db, prepared)
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                "Не удалось создать токен агента (сбой id в PostgreSQL после миграции). "
                "Перезапустите API или выполните: python scripts/fix_pg_sequences.py"
            ),
        ) from exc
    if not token:
        raise HTTPException(status_code=400, detail="Linux-агенту нужен токен")
    return token


@router.post("/linux-command")
async def linux_install_command(
    body: AgentBundleCreate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """One command for the Linux host. The service, interval, and later actions stay on the panel."""
    token = await _linux_token(db, body)
    interval = 60 if body.audit_interval_seconds is None else body.audit_interval_seconds
    try:
        command = one_command(body.server_url, token, interval)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"command": command, "token": token}


@router.post("/linux-ssh")
async def linux_ssh_install(
    body: LinuxSshInstallIn,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Install the same agent over SSH. The password is used once and is not stored."""
    token = await _linux_token(db, body)
    interval = 60 if body.audit_interval_seconds is None else body.audit_interval_seconds
    try:
        script = installer_source(body.server_url, token, interval)
        result = await asyncio.to_thread(
            push_over_ssh,
            body.ssh_host,
            body.ssh_port,
            body.ssh_user,
            body.ssh_password,
            script,
            token,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except InstallError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    result["token"] = token
    return result


@router.post("/windows-winrm")
async def windows_winrm_install(
    body: WindowsWinrmInstallIn,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Install the tray agent on one LAN PC. The password is not stored."""
    from app.agent_bundle import _resolve_agent_token
    from app.agent_cpp_build import build_cpp_agent_exe

    prepared = body.model_copy(update={"target": "windows", "create_token": True})
    try:
        token, _created = await _resolve_agent_token(db, prepared)
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                "Не удалось создать токен агента (сбой id в PostgreSQL после миграции). "
                "Перезапустите API или выполните: python scripts/fix_pg_sequences.py"
            ),
        ) from exc
    if not token:
        raise HTTPException(status_code=400, detail="Агенту нужен токен")
    try:
        exe, _name = build_cpp_agent_exe(prepared, token, quiet=True)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if body.method == "smb":
        try:
            result = await asyncio.to_thread(
                push_over_smb,
                body.winrm_host,
                body.winrm_user,
                body.winrm_password,
                exe,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except WindowsInstallError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    else:
        stage_windows_exe(token, exe)
        try:
            result = await asyncio.to_thread(
                push_over_winrm,
                body.winrm_host,
                body.winrm_port,
                body.winrm_user,
                body.winrm_password,
                body.server_url,
                token,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except WindowsInstallError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        finally:
            discard_windows_exe(token)
    result["token"] = token
    return result
