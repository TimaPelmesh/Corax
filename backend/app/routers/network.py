from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_serializer
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_editor_or_superuser, get_current_user
from app.database import get_db
from app.models import Computer, NetworkDevice, NetworkLink, Printer, User
from app.network_classify import NETWORK_DEVICE_TYPES, infer_network_role, network_dedupe_key_for_ip
from app.network_poll import poll_single_device
from app.network_poll_config import get_effective_network_poll_config, get_network_poll_config_row, parse_cidr_list
from app.network_snmp import fetch_network_snmp

router = APIRouter(prefix="/network", tags=["network"])

_IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
_DEVICE_TYPES = NETWORK_DEVICE_TYPES


def _ser_dt(v: datetime | None):
    if v is None:
        return None
    if v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v.isoformat().replace("+00:00", "Z")


class NetworkDeviceOut(BaseModel):
    id: int
    ip_address: str
    hostname: str | None
    sys_name: str | None
    sys_descr: str | None
    sys_object_id: str | None
    device_type: str
    role: str = "unknown"
    vendor: str | None
    location: str | None
    snmp_status: str | None
    snmp_error: str | None
    last_snmp_at: datetime | None
    last_seen_at: datetime | None
    interfaces: list[dict[str, Any]] = []
    neighbors: list[dict[str, Any]] = []
    fdb: list[dict[str, Any]] = []
    extras: dict[str, Any] = {}
    source: str
    notes: str | None
    created_at: datetime | None
    updated_at: datetime | None

    @field_serializer("last_snmp_at", "last_seen_at", "created_at", "updated_at")
    def _ser(self, v: datetime | None):
        return _ser_dt(v)


class NetworkDeviceCreate(BaseModel):
    ip_address: str = Field(min_length=7, max_length=64)
    hostname: str | None = Field(default=None, max_length=255)
    device_type: str | None = Field(default=None, max_length=32)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = None


class NetworkDevicePatch(BaseModel):
    hostname: str | None = Field(default=None, max_length=255)
    device_type: str | None = Field(default=None, max_length=32)
    location: str | None = Field(default=None, max_length=255)
    notes: str | None = None
    ip_address: str | None = Field(default=None, max_length=64)


class NetworkBulkDelete(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)


class NetworkDiscoveryOut(BaseModel):
    scanned: int
    found: int
    created: int
    updated: int
    skipped: int = 0
    errors: int
    duration_ms: int
    networks: list[str]
    message: str


class NetworkPollResultOut(BaseModel):
    polled: int
    online: int
    offline: int
    snmp_ok: int = 0
    snmp_error: int = 0
    duration_ms: int = 0
    discovered: int = 0
    discovery_created: int = 0
    discovery_updated: int = 0
    links_devices: int = 0
    links_computers: int = 0
    message: str = ""
    networks: list[str] = []


class NetworkJobStatusOut(BaseModel):
    running: bool
    kind: str
    phase: str
    progress: int
    message: str
    started_at: str | None = None
    finished_at: str | None = None
    last_result: dict[str, Any] = {}
    error: str | None = None


class NetworkPollConfigOut(BaseModel):
    poll_enabled: bool
    poll_interval_minutes: int
    snmp_community: str
    snmp_community_set: bool = True
    snmp_timeout_seconds: float
    poll_concurrency: int
    cidr_list: list[str] = []
    last_run_at: datetime | None = None

    @field_serializer("last_run_at")
    def _ser_last(self, v: datetime | None):
        return _ser_dt(v)


class NetworkPollConfigUpdate(BaseModel):
    poll_enabled: bool | None = None
    poll_interval_minutes: int | None = Field(default=None, ge=5, le=1440)
    snmp_community: str | None = Field(default=None, max_length=128)
    snmp_timeout_seconds: float | None = Field(default=None, ge=1.0, le=60.0)
    poll_concurrency: int | None = Field(default=None, ge=1, le=48)
    cidr_list: list[str] | None = None


class TopologyNode(BaseModel):
    id: str
    kind: str
    ref_id: int
    label: str
    device_type: str | None = None
    ip_address: str | None = None
    vendor: str | None = None
    snmp_status: str | None = None


class TopologyEdge(BaseModel):
    id: str
    source: str
    target: str
    link_type: str
    local_port: str | None = None
    remote_port: str | None = None
    confidence: float = 1.0


class TopologyOut(BaseModel):
    nodes: list[TopologyNode]
    edges: list[TopologyEdge]


def _validate_ip(ip: str | None) -> str | None:
    if not ip:
        return None
    s = ip.strip()
    if not _IP_RE.match(s):
        raise HTTPException(status_code=400, detail="Некорректный IP-адрес")
    parts = s.split(".")
    if not all(0 <= int(p) <= 255 for p in parts):
        raise HTTPException(status_code=400, detail="Некорректный IP-адрес")
    return s


def _parse_json_list(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)]


def _parse_extras(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _device_out(row: NetworkDevice, *, include_details: bool = False) -> NetworkDeviceOut:
    dtype = row.device_type or "unknown"
    role = infer_network_role(
        hostname=row.hostname,
        sys_name=row.sys_name,
        device_type=dtype,
        source=row.source,
    )
    return NetworkDeviceOut(
        id=row.id,
        ip_address=row.ip_address,
        hostname=row.hostname,
        sys_name=row.sys_name,
        sys_descr=row.sys_descr if include_details else None,
        sys_object_id=row.sys_object_id,
        device_type=dtype,
        role=role,
        vendor=row.vendor,
        location=row.location,
        snmp_status=row.snmp_status,
        snmp_error=row.snmp_error if include_details else None,
        last_snmp_at=row.last_snmp_at,
        last_seen_at=row.last_seen_at,
        interfaces=_parse_json_list(row.interfaces_json) if include_details else [],
        neighbors=_parse_json_list(row.neighbors_json) if include_details else [],
        fdb=_parse_json_list(row.fdb_json) if include_details else [],
        extras=_parse_extras(getattr(row, "extras_json", None)) if include_details else {},
        source=row.source or "snmp",
        notes=row.notes,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("/devices", response_model=list[NetworkDeviceOut])
async def list_devices(
    q: str | None = Query(default=None),
    device_type: str | None = Query(default=None),
    role: str | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=2000),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(NetworkDevice).order_by(NetworkDevice.hostname.asc().nulls_last(), NetworkDevice.ip_address.asc())
    if device_type and device_type.strip() and device_type.strip() != "all":
        stmt = stmt.where(NetworkDevice.device_type == device_type.strip())
    if q and q.strip():
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(func.coalesce(NetworkDevice.hostname, "")).like(needle),
                func.lower(NetworkDevice.ip_address).like(needle),
                func.lower(func.coalesce(NetworkDevice.vendor, "")).like(needle),
                func.lower(func.coalesce(NetworkDevice.sys_name, "")).like(needle),
                func.lower(func.coalesce(NetworkDevice.location, "")).like(needle),
            )
        )
    rows = (await db.execute(stmt.limit(limit))).scalars().all()
    out = [_device_out(r) for r in rows]
    role_f = (role or "").strip().lower()
    if role_f and role_f != "all":
        out = [d for d in out if d.role == role_f]
    return out


@router.get("/devices/{device_id}", response_model=NetworkDeviceOut)
async def get_device(
    device_id: int,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(NetworkDevice).where(NetworkDevice.id == device_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    return _device_out(row, include_details=True)


@router.post("/devices", response_model=NetworkDeviceOut)
async def create_device(
    body: NetworkDeviceCreate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    ip = _validate_ip(body.ip_address)
    assert ip
    dedupe = network_dedupe_key_for_ip(ip)
    existing = (
        await db.execute(
            select(NetworkDevice).where(
                (NetworkDevice.ip_address == ip) | (NetworkDevice.dedupe_key == dedupe)
            ).limit(1)
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Устройство с таким IP уже есть")

    dtype = (body.device_type or "unknown").strip().lower()
    if dtype not in _DEVICE_TYPES:
        dtype = "unknown"

    cfg = await get_effective_network_poll_config(db)
    now = datetime.now(timezone.utc)
    row = NetworkDevice(
        dedupe_key=dedupe,
        ip_address=ip,
        hostname=(body.hostname or f"Device {ip}")[:255],
        device_type=dtype,
        location=body.location,
        notes=body.notes,
        source="manual",
        snmp_status="unknown",
        last_seen_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    # Optional immediate probe
    try:
        snap = await fetch_network_snmp(ip, community=cfg.snmp_community, timeout=min(cfg.snmp_timeout_seconds, 3.0))
        if snap.sys_descr or snap.sys_name:
            from app.network_poll import _apply_snapshot

            await _apply_snapshot(row, snap, now)
            if snap.device_type and snap.device_type != "printer":
                row.device_type = snap.device_type
            await db.commit()
            await db.refresh(row)
    except Exception:
        pass

    return _device_out(row, include_details=True)


@router.patch("/devices/{device_id}", response_model=NetworkDeviceOut)
async def patch_device(
    device_id: int,
    body: NetworkDevicePatch,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(NetworkDevice).where(NetworkDevice.id == device_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    if body.hostname is not None:
        row.hostname = body.hostname.strip()[:255] or row.hostname
    if body.device_type is not None:
        dtype = body.device_type.strip().lower()
        if dtype not in _DEVICE_TYPES:
            raise HTTPException(status_code=400, detail="Некорректный тип устройства")
        row.device_type = dtype
    if body.location is not None:
        row.location = body.location
    if body.notes is not None:
        row.notes = body.notes
    if body.ip_address is not None:
        ip = _validate_ip(body.ip_address)
        assert ip
        row.ip_address = ip
        row.dedupe_key = network_dedupe_key_for_ip(ip)
    await db.commit()
    await db.refresh(row)
    return _device_out(row, include_details=True)


@router.delete("/devices/{device_id}", status_code=204)
async def delete_device(
    device_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(NetworkDevice).where(NetworkDevice.id == device_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    await db.execute(
        delete(NetworkLink).where(
            or_(
                (NetworkLink.from_type == "network_device") & (NetworkLink.from_id == device_id),
                (NetworkLink.to_type == "network_device") & (NetworkLink.to_id == device_id),
            )
        )
    )
    await db.delete(row)
    await db.commit()
    return None


@router.post("/devices/bulk-delete", status_code=204)
async def bulk_delete_devices(
    body: NetworkBulkDelete,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    ids = list({int(i) for i in body.ids})
    await db.execute(
        delete(NetworkLink).where(
            or_(
                (NetworkLink.from_type == "network_device") & (NetworkLink.from_id.in_(ids)),
                (NetworkLink.to_type == "network_device") & (NetworkLink.to_id.in_(ids)),
            )
        )
    )
    await db.execute(delete(NetworkDevice).where(NetworkDevice.id.in_(ids)))
    await db.commit()
    return None


@router.get("/job-status", response_model=NetworkJobStatusOut)
async def network_job_status(_: User = Depends(get_current_user)):
    from app.network_job import network_job_runner

    return NetworkJobStatusOut(**network_job_runner.snapshot())


@router.post("/discover", response_model=NetworkJobStatusOut)
async def discover_devices(
    _: User = Depends(get_current_editor_or_superuser),
):
    """Start background discovery — returns immediately; poll /job-status."""
    from app.network_job import network_job_runner

    return NetworkJobStatusOut(**(await network_job_runner.start("discover")))


@router.post("/poll", response_model=NetworkJobStatusOut)
async def poll_network(
    _: User = Depends(get_current_editor_or_superuser),
):
    """Start background discover+poll — safe to leave the page; poll /job-status."""
    from app.network_job import network_job_runner

    return NetworkJobStatusOut(**(await network_job_runner.start("poll")))


@router.post("/devices/{device_id}/poll", response_model=NetworkDeviceOut)
async def poll_device(
    device_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    try:
        row = await poll_single_device(db, device_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Устройство не найдено") from None
    return _device_out(row, include_details=True)


@router.get("/poll-config", response_model=NetworkPollConfigOut)
async def get_poll_config(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = await get_network_poll_config_row(db)
    return NetworkPollConfigOut(
        poll_enabled=bool(row.poll_enabled),
        poll_interval_minutes=int(row.poll_interval_minutes or 120),
        snmp_community=(row.snmp_community or "public").strip() or "public",
        snmp_community_set=bool((row.snmp_community or "").strip()),
        snmp_timeout_seconds=float(row.snmp_timeout_seconds or 3.5),
        poll_concurrency=int(row.poll_concurrency or 8),
        cidr_list=parse_cidr_list(row.cidr_list_json),
        last_run_at=row.last_run_at,
    )


@router.put("/poll-config", response_model=NetworkPollConfigOut)
async def update_poll_config(
    body: NetworkPollConfigUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await get_network_poll_config_row(db)
    if body.poll_enabled is not None:
        row.poll_enabled = bool(body.poll_enabled)
    if body.poll_interval_minutes is not None:
        row.poll_interval_minutes = int(body.poll_interval_minutes)
    if body.snmp_community is not None:
        row.snmp_community = body.snmp_community.strip() or "public"
    if body.snmp_timeout_seconds is not None:
        row.snmp_timeout_seconds = float(body.snmp_timeout_seconds)
    if body.poll_concurrency is not None:
        row.poll_concurrency = int(body.poll_concurrency)
    if body.cidr_list is not None:
        cleaned = [c.strip() for c in body.cidr_list if c and c.strip()]
        row.cidr_list_json = json.dumps(cleaned, ensure_ascii=False) if cleaned else None
    await db.commit()
    await db.refresh(row)
    return NetworkPollConfigOut(
        poll_enabled=bool(row.poll_enabled),
        poll_interval_minutes=int(row.poll_interval_minutes or 120),
        snmp_community=(row.snmp_community or "public").strip() or "public",
        snmp_community_set=bool((row.snmp_community or "").strip()),
        snmp_timeout_seconds=float(row.snmp_timeout_seconds or 3.5),
        poll_concurrency=int(row.poll_concurrency or 8),
        cidr_list=parse_cidr_list(row.cidr_list_json),
        last_run_at=row.last_run_at,
    )


@router.get("/topology", response_model=TopologyOut)
async def get_topology(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    devices = (await db.execute(select(NetworkDevice))).scalars().all()
    links = (await db.execute(select(NetworkLink))).scalars().all()

    nodes: dict[str, TopologyNode] = {}
    for d in devices:
        nid = f"network_device:{d.id}"
        nodes[nid] = TopologyNode(
            id=nid,
            kind="network_device",
            ref_id=d.id,
            label=d.hostname or d.sys_name or d.ip_address,
            device_type=d.device_type,
            ip_address=d.ip_address,
            vendor=d.vendor,
            snmp_status=d.snmp_status,
        )

    # Only include computers/printers that appear in links
    needed_computers: set[int] = set()
    needed_printers: set[int] = set()
    for link in links:
        for typ, oid in ((link.from_type, link.from_id), (link.to_type, link.to_id)):
            if typ == "computer":
                needed_computers.add(oid)
            elif typ == "printer":
                needed_printers.add(oid)

    if needed_computers:
        comps = (
            await db.execute(select(Computer).where(Computer.id.in_(needed_computers)))
        ).scalars().all()
        for c in comps:
            nid = f"computer:{c.id}"
            nodes[nid] = TopologyNode(
                id=nid,
                kind="computer",
                ref_id=c.id,
                label=c.hostname,
                device_type="computer",
                ip_address=None,
                vendor=c.manufacturer,
            )

    if needed_printers:
        prns = (
            await db.execute(select(Printer).where(Printer.id.in_(needed_printers)))
        ).scalars().all()
        for p in prns:
            nid = f"printer:{p.id}"
            nodes[nid] = TopologyNode(
                id=nid,
                kind="printer",
                ref_id=p.id,
                label=p.name or p.ip_address or f"Printer {p.id}",
                device_type="printer",
                ip_address=p.ip_address,
            )

    edges: list[TopologyEdge] = []
    for link in links:
        src = f"{link.from_type}:{link.from_id}"
        tgt = f"{link.to_type}:{link.to_id}"
        if src not in nodes or tgt not in nodes:
            continue
        edges.append(
            TopologyEdge(
                id=f"link:{link.id}",
                source=src,
                target=tgt,
                link_type=link.link_type,
                local_port=link.local_port,
                remote_port=link.remote_port,
                confidence=float(link.confidence or 1.0),
            )
        )

    return TopologyOut(nodes=list(nodes.values()), edges=edges)
