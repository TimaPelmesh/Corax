"""Docker Swarm from the panel: inventory hosts, SSH join/init, allowlisted docker."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_user
from app.database import get_db
from app.linux_install import InstallError, clean_ssh_host, clean_ssh_user, run_remote_commands
from app.models import SwarmHost, User
from app.observability import get_logger
from app.swarm_ssh import (
    advertise_addr,
    humanize_docker_error,
    init_commands,
    join_commands,
    join_token_commands,
    leave_commands,
    manager_listen_addr,
    nodes_from_output,
    overview_commands,
    parse_swarm_info,
    probe_commands,
    rollback_commands,
    scale_commands,
    services_from_output,
    swarm_role,
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


class SwarmHostCreate(BaseModel):
    label: str = Field(default="", max_length=128)
    host: str = Field(min_length=1, max_length=255)
    ssh_port: int = Field(default=22, ge=1, le=65535)
    ssh_user: str = Field(default="root", min_length=1, max_length=32)
    role: str = Field(default="worker", max_length=16)
    advertise_addr: str = Field(default="", max_length=255)
    notes: str | None = Field(default=None, max_length=2000)
    enabled: bool = True


class SwarmHostPatch(BaseModel):
    label: str | None = Field(default=None, max_length=128)
    host: str | None = Field(default=None, min_length=1, max_length=255)
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_user: str | None = Field(default=None, min_length=1, max_length=32)
    role: str | None = Field(default=None, max_length=16)
    advertise_addr: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=2000)
    enabled: bool | None = None


class SwarmHostAuth(BaseModel):
    ssh_password: str = Field(min_length=1, max_length=256)


class SwarmInitIn(SwarmHostAuth):
    advertise_addr: str | None = Field(default=None, max_length=255)


class SwarmJoinTokenIn(SwarmHostAuth):
    token_role: str = Field(default="worker", max_length=16)


class SwarmJoinIn(SwarmHostAuth):
    token: str = Field(min_length=16, max_length=256)
    manager_addr: str = Field(min_length=3, max_length=255)


class SwarmLeaveIn(SwarmHostAuth):
    force: bool = False


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


class SwarmHostOut(BaseModel):
    id: int
    label: str = ""
    host: str
    ssh_port: int = 22
    ssh_user: str = "root"
    role: str = "worker"
    advertise_addr: str = ""
    enabled: bool = True
    notes: str | None = None
    last_node_name: str = ""
    last_node_id: str = ""
    last_swarm_state: str = ""
    last_is_manager: bool = False
    last_error: str = ""
    last_checked_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SwarmProbeOut(BaseModel):
    ok: bool
    host: SwarmHostOut
    output: str = ""


class SwarmJoinTokenOut(BaseModel):
    ok: bool
    token: str = ""
    token_role: str = "worker"
    manager_addr: str = ""
    output: str = ""


def _swarm_user(current: User = Depends(require_user)) -> User:
    if current.is_superuser or (current.role or "").strip().lower() == "editor":
        return current
    raise HTTPException(status_code=403, detail="Недостаточно прав для Docker Swarm")


def _host(body: SwarmLogin) -> str:
    try:
        return clean_ssh_host(body.host)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _clean_host_fields(host: str, user: str, role: str, addr: str) -> tuple[str, str, str, str]:
    try:
        clean_host = clean_ssh_host(host)
        clean_user = clean_ssh_user(user)
        clean_role = swarm_role(role)
        clean_addr = advertise_addr(addr) or ""
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return clean_host, clean_user, clean_role, clean_addr


async def _run_login(body: SwarmLogin, commands: list[tuple[str, float]]) -> list[dict]:
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


async def _run_row(row: SwarmHost, password: str, commands: list[tuple[str, float]]) -> list[dict]:
    try:
        return await asyncio.to_thread(
            run_remote_commands,
            clean_ssh_host(row.host),
            int(row.ssh_port or 22),
            clean_ssh_user(row.ssh_user or "root"),
            password,
            commands,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except InstallError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _overview(results: list[dict]) -> SwarmOverviewOut:
    info = results[0] if results else {"ok": False, "output": "", "exit_code": 1}
    if not info.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=humanize_docker_error(str(info.get("output") or ""), "docker info не выполнился"),
        )
    state, manager = parse_swarm_info(str(info.get("output") or ""))
    nodes_text = results[1]["output"] if len(results) > 1 and results[1].get("ok") else ""
    services_text = results[2]["output"] if len(results) > 2 and results[2].get("ok") else ""
    tail = results[-1]
    return SwarmOverviewOut(
        ok=bool(tail.get("ok")),
        swarm=state,
        manager=manager,
        nodes=[SwarmNodeOut(**item) for item in nodes_from_output(nodes_text)],
        services=[SwarmServiceOut(**item) for item in services_from_output(services_text)],
        output=str(tail.get("output") or "")[:4000],
    )


def _parse_probe(text: str) -> tuple[str, str, bool, str]:
    line = ""
    for raw in (text or "").splitlines():
        if "|" in raw:
            line = raw.strip()
    if not line:
        return "", "", False, ""
    parts = line.split("|")
    name = (parts[0] if parts else "").strip()[:255]
    state = (parts[1] if len(parts) > 1 else "").strip()[:32]
    manager = (parts[2] if len(parts) > 2 else "").strip().lower() == "true"
    node_id = (parts[3] if len(parts) > 3 else "").strip()[:64]
    return name, state, manager, node_id


def _host_out(row: SwarmHost) -> SwarmHostOut:
    return SwarmHostOut(
        id=row.id,
        label=row.label or "",
        host=row.host,
        ssh_port=int(row.ssh_port or 22),
        ssh_user=row.ssh_user or "root",
        role=row.role or "worker",
        advertise_addr=row.advertise_addr or "",
        enabled=bool(row.enabled),
        notes=row.notes,
        last_node_name=row.last_node_name or "",
        last_node_id=row.last_node_id or "",
        last_swarm_state=row.last_swarm_state or "",
        last_is_manager=bool(row.last_is_manager),
        last_error=row.last_error or "",
        last_checked_at=row.last_checked_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _get_host(db: AsyncSession, host_id: int) -> SwarmHost:
    row = await db.get(SwarmHost, host_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Узел Swarm не найден")
    return row


async def _apply_probe(db: AsyncSession, row: SwarmHost, results: list[dict]) -> SwarmHost:
    now = datetime.now(timezone.utc)
    row.last_checked_at = now
    head = results[0] if results else {"ok": False, "output": ""}
    if not head.get("ok"):
        row.last_error = humanize_docker_error(str(head.get("output") or ""), "SSH/docker probe failed")
        await db.commit()
        await db.refresh(row)
        return row
    name, state, manager, node_id = _parse_probe(str(head.get("output") or ""))
    row.last_node_name = name
    row.last_swarm_state = state
    row.last_is_manager = manager
    row.last_node_id = node_id
    row.last_error = ""
    if len(results) > 1 and results[-1].get("ok"):
        extra_name, extra_state, extra_manager, extra_id = _parse_probe(str(results[-1].get("output") or ""))
        if extra_name or extra_state or extra_id:
            row.last_node_name = extra_name or row.last_node_name
            row.last_swarm_state = extra_state or row.last_swarm_state
            row.last_is_manager = extra_manager if (extra_name or extra_state or extra_id) else row.last_is_manager
            row.last_node_id = extra_id or row.last_node_id
    await db.commit()
    await db.refresh(row)
    return row


@router.get("/hosts", response_model=list[SwarmHostOut])
async def list_hosts(_: User = Depends(_swarm_user), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(SwarmHost).order_by(SwarmHost.id.asc()))).scalars().all()
    return [_host_out(row) for row in rows]


@router.post("/hosts", response_model=SwarmHostOut)
async def create_host(body: SwarmHostCreate, user: User = Depends(_swarm_user), db: AsyncSession = Depends(get_db)):
    host, ssh_user, role, addr = _clean_host_fields(body.host, body.ssh_user, body.role, body.advertise_addr)
    row = SwarmHost(
        label=(body.label or "").strip()[:128],
        host=host,
        ssh_port=body.ssh_port,
        ssh_user=ssh_user,
        role=role,
        advertise_addr=addr,
        notes=(body.notes or None),
        enabled=bool(body.enabled),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    log.info("swarm host create", extra={"user": user.username, "host": host, "role": role})
    return _host_out(row)


@router.patch("/hosts/{host_id}", response_model=SwarmHostOut)
async def patch_host(
    host_id: int,
    body: SwarmHostPatch,
    user: User = Depends(_swarm_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_host(db, host_id)
    data = body.model_dump(exclude_unset=True)
    if "host" in data or "ssh_user" in data or "role" in data or "advertise_addr" in data:
        host, ssh_user, role, addr = _clean_host_fields(
            data.get("host", row.host),
            data.get("ssh_user", row.ssh_user),
            data.get("role", row.role),
            data.get("advertise_addr", row.advertise_addr or ""),
        )
        row.host = host
        row.ssh_user = ssh_user
        row.role = role
        row.advertise_addr = addr
    if "label" in data:
        row.label = (data["label"] or "").strip()[:128]
    if "ssh_port" in data and data["ssh_port"] is not None:
        row.ssh_port = int(data["ssh_port"])
    if "notes" in data:
        row.notes = data["notes"]
    if "enabled" in data and data["enabled"] is not None:
        row.enabled = bool(data["enabled"])
    await db.commit()
    await db.refresh(row)
    log.info("swarm host patch", extra={"user": user.username, "id": host_id})
    return _host_out(row)


@router.post("/hosts/{host_id}/delete")
async def delete_host(host_id: int, user: User = Depends(_swarm_user), db: AsyncSession = Depends(get_db)):
    row = await _get_host(db, host_id)
    await db.delete(row)
    await db.commit()
    log.info("swarm host delete", extra={"user": user.username, "id": host_id})
    return {"ok": True}


@router.post("/hosts/{host_id}/probe", response_model=SwarmProbeOut)
async def probe_host(
    host_id: int,
    body: SwarmHostAuth,
    user: User = Depends(_swarm_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_host(db, host_id)
    results = await _run_row(row, body.ssh_password, probe_commands())
    row = await _apply_probe(db, row, results)
    log.info("swarm host probe", extra={"user": user.username, "id": host_id, "host": row.host})
    ok = bool(results and results[0].get("ok") and not row.last_error)
    return SwarmProbeOut(ok=ok, host=_host_out(row), output=str((results[-1] if results else {}).get("output") or "")[:4000])


@router.post("/hosts/{host_id}/init", response_model=SwarmProbeOut)
async def init_host(
    host_id: int,
    body: SwarmInitIn,
    user: User = Depends(_swarm_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_host(db, host_id)
    if (row.role or "").lower() != "manager":
        raise HTTPException(status_code=400, detail="Инициализация Swarm только на узле с ролью manager")
    addr = body.advertise_addr if body.advertise_addr is not None else (row.advertise_addr or None)
    try:
        commands = init_commands(addr)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    results = await _run_row(row, body.ssh_password, commands)
    if not results or not results[0].get("ok"):
        detail = humanize_docker_error(
            str((results[0].get("output") if results else "") or ""),
            "docker swarm init не выполнен",
        )
        raise HTTPException(status_code=502, detail=detail)
    if addr:
        try:
            row.advertise_addr = advertise_addr(addr) or row.advertise_addr
        except ValueError:
            pass
    row = await _apply_probe(db, row, results[1:] or results)
    log.info("swarm init", extra={"user": user.username, "id": host_id, "host": row.host})
    return SwarmProbeOut(
        ok=True,
        host=_host_out(row),
        output=str(results[0].get("output") or "")[:4000],
    )


@router.post("/hosts/{host_id}/join-token", response_model=SwarmJoinTokenOut)
async def host_join_token(
    host_id: int,
    body: SwarmJoinTokenIn,
    user: User = Depends(_swarm_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_host(db, host_id)
    try:
        role = swarm_role(body.token_role)
        commands = join_token_commands(role)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    results = await _run_row(row, body.ssh_password, commands)
    if not results or not results[0].get("ok"):
        detail = humanize_docker_error(
            str((results[0].get("output") if results else "") or ""),
            "join-token не получен",
        )
        raise HTTPException(status_code=502, detail=detail)
    token = str(results[0].get("output") or "").strip().splitlines()[-1].strip() if results[0].get("output") else ""
    if not token.startswith("SWMTKN-"):
        raise HTTPException(
            status_code=502,
            detail=humanize_docker_error(str(results[0].get("output") or ""), "Ответ join-token не похож на токен Swarm"),
        )
    manager_host = (row.advertise_addr or row.host or "").strip()
    try:
        manager_addr = manager_listen_addr(manager_host)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    log.info("swarm join-token", extra={"user": user.username, "id": host_id, "role": role})
    return SwarmJoinTokenOut(ok=True, token=token, token_role=role, manager_addr=manager_addr, output=token)


@router.post("/hosts/{host_id}/join", response_model=SwarmProbeOut)
async def join_host(
    host_id: int,
    body: SwarmJoinIn,
    user: User = Depends(_swarm_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_host(db, host_id)
    try:
        commands = join_commands(body.token, body.manager_addr)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    results = await _run_row(row, body.ssh_password, commands)
    if not results or not results[0].get("ok"):
        detail = humanize_docker_error(
            str((results[0].get("output") if results else "") or ""),
            "docker swarm join не выполнен",
        )
        raise HTTPException(status_code=502, detail=detail)
    row = await _apply_probe(db, row, results[1:] or results)
    log.info("swarm join", extra={"user": user.username, "id": host_id, "host": row.host})
    return SwarmProbeOut(ok=True, host=_host_out(row), output=str(results[0].get("output") or "")[:4000])


@router.post("/hosts/{host_id}/leave", response_model=SwarmProbeOut)
async def leave_host(
    host_id: int,
    body: SwarmLeaveIn,
    user: User = Depends(_swarm_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_host(db, host_id)
    results = await _run_row(row, body.ssh_password, leave_commands(force=bool(body.force)))
    if not results or not results[0].get("ok"):
        detail = humanize_docker_error(
            str((results[0].get("output") if results else "") or ""),
            "docker swarm leave не выполнен",
        )
        raise HTTPException(status_code=502, detail=detail)
    row = await _apply_probe(db, row, results[1:] or results)
    log.info("swarm leave", extra={"user": user.username, "id": host_id, "host": row.host})
    return SwarmProbeOut(ok=True, host=_host_out(row), output=str(results[0].get("output") or "")[:4000])


@router.post("/hosts/{host_id}/overview", response_model=SwarmOverviewOut)
async def host_overview(
    host_id: int,
    body: SwarmHostAuth,
    user: User = Depends(_swarm_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_host(db, host_id)
    results = await _run_row(row, body.ssh_password, overview_commands())
    overview = _overview(results)
    # Refresh probe fields from overview info line
    state, manager = overview.swarm, overview.manager
    row.last_checked_at = datetime.now(timezone.utc)
    row.last_swarm_state = state
    row.last_is_manager = manager
    row.last_error = ""
    await db.commit()
    log.info("swarm host overview", extra={"user": user.username, "id": host_id, "host": row.host})
    return overview


@router.post("/overview", response_model=SwarmOverviewOut)
async def swarm_overview(body: SwarmLogin, user: User = Depends(_swarm_user)):
    results = await _run_login(body, overview_commands())
    log.info("swarm overview", extra={"user": user.username, "host": _host(body)})
    return _overview(results)


@router.post("/scale", response_model=SwarmOverviewOut)
async def swarm_scale(body: SwarmScaleIn, user: User = Depends(_swarm_user)):
    try:
        commands = scale_commands(body.service, body.replicas)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    results = await _run_login(body, commands)
    log.info(
        "swarm scale",
        extra={"user": user.username, "host": _host(body), "service": body.service, "replicas": body.replicas},
    )
    if not results or not results[0].get("ok"):
        detail = humanize_docker_error(
            str((results[0].get("output") if results else "") or ""),
            "Масштаб службы не изменился",
        )
        raise HTTPException(status_code=502, detail=detail)
    if len(results) < 2 or not results[-1].get("ok"):
        raise HTTPException(
            status_code=502,
            detail=humanize_docker_error(
                str(results[-1].get("output") if results else ""),
                "Список служб не обновился",
            ),
        )
    services = services_from_output(results[-1]["output"])
    return SwarmOverviewOut(
        ok=True,
        services=[SwarmServiceOut(**item) for item in services],
        output=str(results[0].get("output") or "")[:4000],
    )


@router.post("/rollback", response_model=SwarmOverviewOut)
async def swarm_rollback(body: SwarmRollbackIn, user: User = Depends(_swarm_user)):
    try:
        commands = rollback_commands(body.service)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    results = await _run_login(body, commands)
    log.info("swarm rollback", extra={"user": user.username, "host": _host(body), "service": body.service})
    if not results or not results[0].get("ok"):
        detail = humanize_docker_error(
            str((results[0].get("output") if results else "") or ""),
            "Откат службы не выполнен",
        )
        raise HTTPException(status_code=502, detail=detail)
    if len(results) < 2 or not results[-1].get("ok"):
        raise HTTPException(
            status_code=502,
            detail=humanize_docker_error(
                str(results[-1].get("output") if results else ""),
                "Список служб не обновился",
            ),
        )
    services = services_from_output(results[-1]["output"])
    return SwarmOverviewOut(
        ok=True,
        services=[SwarmServiceOut(**item) for item in services],
        output=str(results[0].get("output") or "")[:4000],
    )
