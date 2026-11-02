"""Docker Swarm from the panel: one SSH session, allowlisted docker commands."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.linux_install import InstallError, clean_ssh_host, run_remote_commands
from app.models import User
from app.observability import get_logger
from app.swarm_ssh import (
    nodes_from_output,
    overview_commands,
    parse_swarm_info,
    rollback_commands,
    scale_commands,
    services_from_output,
)

log = get_logger("corax.swarm")
router = APIRouter(prefix="/swarm", tags=["swarm"])


class SwarmLogin(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    ssh_port: int = Field(default=22, ge=1, le=65535)
    ssh_user: str = Field(default="root", min_length=1, max_length=32)
    ssh_password: str = Field(min_length=1, max_length=256)


class SwarmScaleIn(SwarmLogin):
    service: str = Field(min_length=1, max_length=63)
    replicas: int = Field(ge=0, le=32)


class SwarmRollbackIn(SwarmLogin):
    service: str = Field(min_length=1, max_length=63)


class SwarmNodeOut(BaseModel):
    id: str = ""
    hostname: str = ""
    status: str = ""
    availability: str = ""
    manager: str = ""
    engine: str = ""


class SwarmServiceOut(BaseModel):
    id: str = ""
    name: str = ""
    mode: str = ""
    replicas: str = ""
    image: str = ""
    ports: str = ""


class SwarmOverviewOut(BaseModel):
    ok: bool
    swarm: str = ""
    manager: bool = False
    nodes: list[SwarmNodeOut] = Field(default_factory=list)
    services: list[SwarmServiceOut] = Field(default_factory=list)
    output: str = ""


def _swarm_user(current: User = Depends(get_current_user)) -> User:
    if current.is_superuser or (current.role or "").strip().lower() == "editor":
        return current
    raise HTTPException(status_code=403, detail="Недостаточно прав для Docker Swarm")


def _host(body: SwarmLogin) -> str:
    try:
        return clean_ssh_host(body.host)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _run(body: SwarmLogin, commands: list[tuple[str, float]]) -> list[dict]:
    host = _host(body)
    try:
        return await asyncio.to_thread(
            run_remote_commands,
            host,
            body.ssh_port,
            body.ssh_user,
            body.ssh_password,
            commands,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except InstallError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _overview(results: list[dict]) -> SwarmOverviewOut:
    info = results[0] if results else {"ok": False, "output": "", "exit_code": 1}
    if not info.get("ok"):
        raise HTTPException(status_code=502, detail=(info.get("output") or "docker info не выполнился")[:500])
    state, manager = parse_swarm_info(str(info.get("output") or ""))
    nodes_text = results[1]["output"] if len(results) > 1 and results[1].get("ok") else ""
    services_text = results[2]["output"] if len(results) > 2 and results[2].get("ok") else ""
    tail = results[-1]
    return SwarmOverviewOut(
        ok=bool(tail.get("ok")),
        swarm=state,
        manager=manager,
        nodes=[SwarmNodeOut(**row) for row in nodes_from_output(nodes_text)],
        services=[SwarmServiceOut(**row) for row in services_from_output(services_text)],
        output=str(tail.get("output") or "")[:4000],
    )


@router.post("/overview", response_model=SwarmOverviewOut)
async def swarm_overview(body: SwarmLogin, user: User = Depends(_swarm_user)):
    results = await _run(body, overview_commands())
    log.info("swarm overview", extra={"user": user.username, "host": _host(body)})
    return _overview(results)


@router.post("/scale", response_model=SwarmOverviewOut)
async def swarm_scale(body: SwarmScaleIn, user: User = Depends(_swarm_user)):
    try:
        commands = scale_commands(body.service, body.replicas)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    results = await _run(body, commands)
    log.info(
        "swarm scale",
        extra={"user": user.username, "host": _host(body), "service": body.service, "replicas": body.replicas},
    )
    if not results or not results[0].get("ok"):
        detail = (results[0].get("output") if results else "") or "Масштаб службы не изменился"
        raise HTTPException(status_code=502, detail=str(detail)[:500])
    if len(results) < 2 or not results[-1].get("ok"):
        raise HTTPException(status_code=502, detail=str(results[-1].get("output") if results else "")[:500] or "Список служб не обновился")
    services = services_from_output(results[-1]["output"])
    return SwarmOverviewOut(
        ok=True,
        services=[SwarmServiceOut(**row) for row in services],
        output=str(results[0].get("output") or "")[:4000],
    )


@router.post("/rollback", response_model=SwarmOverviewOut)
async def swarm_rollback(body: SwarmRollbackIn, user: User = Depends(_swarm_user)):
    try:
        commands = rollback_commands(body.service)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    results = await _run(body, commands)
    log.info("swarm rollback", extra={"user": user.username, "host": _host(body), "service": body.service})
    if not results or not results[0].get("ok"):
        detail = (results[0].get("output") if results else "") or "Откат службы не выполнен"
        raise HTTPException(status_code=502, detail=str(detail)[:500])
    if len(results) < 2 or not results[-1].get("ok"):
        raise HTTPException(status_code=502, detail=str(results[-1].get("output") if results else "")[:500] or "Список служб не обновился")
    services = services_from_output(results[-1]["output"])
    return SwarmOverviewOut(
        ok=True,
        services=[SwarmServiceOut(**row) for row in services],
        output=str(results[0].get("output") or "")[:4000],
    )
