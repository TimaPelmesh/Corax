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
from app.secret_mask import can_read_integration_secrets, mask_secret
from app.local_ip import advertise_lan_ipv4
from app.models import Computer, NetworkDevice, NetworkLink, NetworkMapScene, Printer, User
from app.network_classify import NETWORK_DEVICE_TYPES, infer_network_role, network_dedupe_key_for_ip
from app.network_link_builder import AUTO_LINK_TYPES
from app.network_map_scene import (
    BIND_TYPES,
    LINK_ENDPOINT_TYPES,
    dumps_scene,
    empty_scene,
    normalize_scene,
)
from app.network_poll import poll_single_device
from app.network_poll_config import get_effective_network_poll_config, get_network_poll_config_row, parse_cidr_list
from app.network_snmp import fetch_network_snmp
from app.search_index import delete_search_document, index_record

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
    zabbix: dict[str, Any] | None = None
    port_count: int | None = None
    neighbor_count: int = 0
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
    role: str | None = None
    ip_addresses: list[str] = []
    ip_forwarding: bool | None = None


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


class NetworkMapSceneOut(BaseModel):
    id: int
    title: str
    scene: dict[str, Any]
    updated_at: datetime | None = None
    updated_by: int | None = None
    node_count: int = 0
    edge_count: int = 0

    @field_serializer("updated_at")
    def _ser_updated(self, v: datetime | None):
        return _ser_dt(v)


class NetworkMapScenePut(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    scene: dict[str, Any]


class NetworkMapSceneCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    mode: str = Field(default="blank", max_length=32)


class NetworkMapTraceIn(BaseModel):
    target: str = Field(min_length=1, max_length=255)
    from_id: str | None = Field(default=None, max_length=120)


class NetworkMapSceneMeta(BaseModel):
    id: int
    title: str
    updated_at: datetime | None = None
    node_count: int = 0
    edge_count: int = 0

    @field_serializer("updated_at")
    def _ser_updated(self, v: datetime | None):
        return _ser_dt(v)


class MapLiveBind(BaseModel):
    type: str = Field(min_length=1, max_length=32)
    id: int


class MapLiveIn(BaseModel):
    binds: list[MapLiveBind] = Field(default_factory=list, max_length=400)


class MapLiveItem(BaseModel):
    type: str
    id: int
    label: str | None = None
    ip: str | None = None
    vendor: str | None = None
    status: str | None = None
    missing: bool = False
    port_count: int | None = None
    ports: list[dict[str, Any]] = []


class MapLiveOut(BaseModel):
    items: list[MapLiveItem]


class NetworkLinkCreate(BaseModel):
    from_type: str = Field(min_length=1, max_length=32)
    from_id: int
    to_type: str = Field(min_length=1, max_length=32)
    to_id: int
    local_port: str | None = Field(default=None, max_length=128)
    remote_port: str | None = Field(default=None, max_length=128)


class NetworkLinkOut(BaseModel):
    id: int
    from_type: str
    from_id: int
    to_type: str
    to_id: int
    link_type: str
    local_port: str | None = None
    remote_port: str | None = None
    confidence: float = 1.0


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


def _topology_l3(extras: dict[str, Any], ip: str | None) -> tuple[list[str], bool | None]:
    ips: list[str] = []
    seen: set[str] = set()
    raw_ips = extras.get("ip_addresses")
    extra_list = raw_ips if isinstance(raw_ips, list) else []
    for raw in [ip, *extra_list]:
        value = str(raw or "").strip().split("/")[0]
        if not value or value in seen:
            continue
        seen.add(value)
        ips.append(value)
    fwd = extras.get("ip_forwarding")
    forwarding = fwd if isinstance(fwd, bool) else None
    return ips[:32], forwarding


def _parse_extras(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _zabbix_summary(extras: dict[str, Any]) -> dict[str, Any] | None:
    zb = extras.get("zabbix")
    if not isinstance(zb, dict) or not zb.get("hostid"):
        return None
    return {
        "hostid": str(zb.get("hostid") or ""),
        "name": zb.get("name") or zb.get("host"),
        "status": zb.get("status"),
        "ip": zb.get("ip"),
    }


def _port_count_from(extras: dict[str, Any], interfaces: list[dict[str, Any]]) -> int | None:
    for key in ("ethernet_ports", "bridge_num_ports"):
        val = extras.get(key)
        try:
            n = int(val)
        except (TypeError, ValueError):
            continue
        if n > 0:
            return n
    eth = [i for i in interfaces if isinstance(i, dict) and int(i.get("if_type") or 0) in {6, 62, 69, 117, 55}]
    if eth:
        return len(eth)
    return None


def _switch_ports(interfaces: list[dict[str, Any]], extras: dict[str, Any], limit: int = 52) -> list[dict[str, Any]]:
    from app.network_map_layout import port_handle_id

    rows: list[dict[str, Any]] = []
    eth = [
        i
        for i in interfaces
        if isinstance(i, dict) and int(i.get("if_type") or 0) in {6, 62, 69, 117, 55}
    ]
    if not eth:
        count = _port_count_from(extras, interfaces) or 0
        for idx in range(min(count, limit)):
            name = str(idx + 1)
            hid = port_handle_id(name)
            if hid:
                rows.append({"id": hid, "name": name, "up": None})
        return rows
    for iface in eth[:limit]:
        name = str(iface.get("name") or iface.get("descr") or iface.get("if_index") or "").strip()
        hid = port_handle_id(name)
        if not hid:
            continue
        rows.append(
            {
                "id": hid,
                "name": name,
                "up": (iface.get("oper_status") or "") == "up",
            }
        )
    return rows


def _topology_node_id(kind: str, oid: int) -> str:
    if kind == "corax":
        return "corax:self"
    return f"{kind}:{oid}"


def _link_out(row: NetworkLink) -> NetworkLinkOut:
    return NetworkLinkOut(
        id=row.id,
        from_type=row.from_type,
        from_id=row.from_id,
        to_type=row.to_type,
        to_id=row.to_id,
        link_type=row.link_type,
        local_port=row.local_port,
        remote_port=row.remote_port,
        confidence=float(row.confidence or 1.0),
    )


async def _ensure_link_endpoint(db: AsyncSession, kind: str, oid: int) -> None:
    k = (kind or "").strip().lower()
    if k not in LINK_ENDPOINT_TYPES:
        raise HTTPException(status_code=400, detail="Некорректный тип узла связи")
    if k == "corax":
        if oid != 0:
            raise HTTPException(status_code=400, detail="Corax всегда id=0")
        return
    if k == "network_device":
        row = (await db.execute(select(NetworkDevice.id).where(NetworkDevice.id == oid))).scalar_one_or_none()
    elif k == "computer":
        row = (await db.execute(select(Computer.id).where(Computer.id == oid))).scalar_one_or_none()
    else:
        row = (await db.execute(select(Printer.id).where(Printer.id == oid))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Узел связи не найден")


async def _default_map_scene(db: AsyncSession) -> NetworkMapScene | None:
    return (await db.execute(select(NetworkMapScene).order_by(NetworkMapScene.id.asc()).limit(1))).scalar_one_or_none()


def _scene_out(row: NetworkMapScene) -> NetworkMapSceneOut:
    try:
        scene = normalize_scene(row.scene_json)
    except HTTPException:
        scene = empty_scene()
    return NetworkMapSceneOut(
        id=row.id,
        title=row.title or "Карта сети",
        scene=scene,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
        node_count=len(scene.get("nodes") or []),
        edge_count=len(scene.get("edges") or []),
    )


def _scene_meta(row: NetworkMapScene) -> NetworkMapSceneMeta:
    try:
        scene = normalize_scene(row.scene_json)
    except HTTPException:
        scene = empty_scene()
    return NetworkMapSceneMeta(
        id=row.id,
        title=row.title or "Карта сети",
        updated_at=row.updated_at,
        node_count=len(scene.get("nodes") or []),
        edge_count=len(scene.get("edges") or []),
    )


def _device_out(row: NetworkDevice, *, include_details: bool = False) -> NetworkDeviceOut:
    dtype = row.device_type or "unknown"
    extras = _parse_extras(getattr(row, "extras_json", None))
    role = infer_network_role(
        hostname=row.hostname,
        sys_name=row.sys_name,
        device_type=dtype,
        source=row.source,
        extras_json=getattr(row, "extras_json", None),
    )
    interfaces = _parse_json_list(row.interfaces_json) if include_details else []
    neighbors = _parse_json_list(row.neighbors_json) if include_details else []
    port_ifaces = interfaces if include_details else _parse_json_list(row.interfaces_json)
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
        interfaces=interfaces,
        neighbors=neighbors,
        fdb=_parse_json_list(row.fdb_json) if include_details else [],
        extras=extras if include_details else {},
        source=row.source or "snmp",
        notes=row.notes,
        zabbix=_zabbix_summary(extras),
        port_count=_port_count_from(extras, port_ifaces),
        neighbor_count=len(neighbors) if include_details else int(extras.get("neighbors_total") or 0),
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
            if snap.device_type == "printer":
                from app.network_snmp_discover import sync_printer_from_network_snap

                await sync_printer_from_network_snap(
                    db,
                    row.ip_address,
                    snap,
                    now=now,
                    snmp_status="error" if snap.error and not snap.sys_descr else "ok",
                )
            await db.commit()
            await db.refresh(row)
    except Exception:
        pass

    await db.flush()
    await index_record(db, row)
    await db.commit()
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
    patch = body.model_dump(exclude_unset=True)
    if body.hostname is not None:
        row.hostname = body.hostname.strip()[:255] or row.hostname
    if body.device_type is not None:
        dtype = body.device_type.strip().lower()
        if dtype not in _DEVICE_TYPES:
            raise HTTPException(status_code=400, detail="Некорректный тип устройства")
        row.device_type = dtype
        extras: dict[str, Any] = {}
        if getattr(row, "extras_json", None):
            try:
                loaded = json.loads(row.extras_json)
                if isinstance(loaded, dict):
                    extras = loaded
            except (TypeError, json.JSONDecodeError):
                extras = {}
        extras["type_manual"] = True
        row.extras_json = json.dumps(extras, ensure_ascii=False)
        if dtype == "printer" and row.ip_address:
            from app.network_snmp import NetworkSnmpSnapshot
            from app.network_snmp_discover import sync_printer_from_network_snap

            snap = NetworkSnmpSnapshot(
                sys_name=row.sys_name or row.hostname,
                sys_descr=row.sys_descr,
                device_type="printer",
                vendor=row.vendor,
                sys_location=row.location,
            )
            await sync_printer_from_network_snap(
                db,
                row.ip_address,
                snap,
                now=datetime.now(timezone.utc),
                snmp_status=(row.snmp_status or "ok"),
            )
    if "location" in patch:
        loc = patch["location"]
        row.location = (loc or "").strip()[:255] or None
    if "notes" in patch:
        notes = patch["notes"]
        row.notes = (notes or "").strip() or None
    if body.ip_address is not None:
        ip = _validate_ip(body.ip_address)
        assert ip
        row.ip_address = ip
        row.dedupe_key = network_dedupe_key_for_ip(ip)
    await db.flush()
    await index_record(db, row)
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
    await delete_search_document(db, "network_device", row.id)
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
    except Exception:
        raise HTTPException(status_code=502, detail="SNMP-опрос не удался") from None
    return _device_out(row, include_details=True)


@router.get("/poll-config", response_model=NetworkPollConfigOut)
async def get_poll_config(current: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = await get_network_poll_config_row(db)
    community = (row.snmp_community or "public").strip() or "public"
    reveal = can_read_integration_secrets(current)
    return NetworkPollConfigOut(
        poll_enabled=bool(row.poll_enabled),
        poll_interval_minutes=int(row.poll_interval_minutes or 120),
        snmp_community=community if reveal else mask_secret(community, reveal=False),
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
    strong = {"lldp", "cdp", "mndp", "ndp", "fdp", "edp", "isdp", "hndp", "fdb"}
    linked_device_ids: set[int] = set()
    for link in links:
        if (link.link_type or "").lower() not in strong:
            continue
        if link.from_type == "network_device":
            linked_device_ids.add(link.from_id)
        if link.to_type == "network_device":
            linked_device_ids.add(link.to_id)

    nodes: dict[str, TopologyNode] = {}
    for d in devices:
        dtype = (d.device_type or "").lower()
        if dtype in {"host", "pc"} and d.id not in linked_device_ids:
            continue
        nid = f"network_device:{d.id}"
        extras = _parse_extras(getattr(d, "extras_json", None))
        extra_ips, forwarding = _topology_l3(extras, d.ip_address)
        nodes[nid] = TopologyNode(
            id=nid,
            kind="network_device",
            ref_id=d.id,
            label=d.hostname or d.sys_name or d.ip_address,
            device_type=d.device_type,
            ip_address=d.ip_address,
            vendor=d.vendor,
            snmp_status=d.snmp_status,
            role=infer_network_role(
                hostname=d.hostname,
                sys_name=d.sys_name,
                device_type=d.device_type,
                source=d.source,
                extras_json=getattr(d, "extras_json", None),
            ),
            ip_addresses=extra_ips,
            ip_forwarding=forwarding,
        )

    # Inventory endpoints only when they already have a discovery link — map is gear-first.
    needed_computers: set[int] = set()
    needed_printers: set[int] = set()
    for link in links:
        if (link.link_type or "").lower() not in strong:
            continue
        for typ, oid in ((link.from_type, link.from_id), (link.to_type, link.to_id)):
            if typ == "computer":
                needed_computers.add(oid)
            elif typ == "printer":
                needed_printers.add(oid)

    comps = (await db.execute(select(Computer).order_by(Computer.id.asc()).limit(2500))).scalars().all()
    for c in comps:
        if c.id not in needed_computers:
            continue
        nid = f"computer:{c.id}"
        nodes[nid] = TopologyNode(
            id=nid,
            kind="computer",
            ref_id=c.id,
            label=c.hostname,
            device_type="computer",
            ip_address=c.ip_address,
            vendor=c.manufacturer,
            snmp_status=c.ping_status,
        )

    prns = (await db.execute(select(Printer).order_by(Printer.id.asc()).limit(800))).scalars().all()
    for p in prns:
        if p.id not in needed_printers:
            continue
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
        src = _topology_node_id(link.from_type, link.from_id)
        tgt = _topology_node_id(link.to_type, link.to_id)
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

    corax_id = "corax:self"
    corax_ip = advertise_lan_ipv4()
    nodes[corax_id] = TopologyNode(
        id=corax_id,
        kind="corax",
        ref_id=0,
        label="Corax",
        device_type="corax",
        ip_address=corax_ip,
        vendor="CORAX",
        snmp_status="ok",
        role="corax",
    )
    return TopologyOut(nodes=list(nodes.values()), edges=edges)


@router.get("/map-scene", response_model=NetworkMapSceneOut)
async def get_map_scene(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _default_map_scene(db)
    if row is None:
        return NetworkMapSceneOut(id=0, title="Карта сети", scene=empty_scene(), updated_at=None, updated_by=None)
    return _scene_out(row)


@router.put("/map-scene", response_model=NetworkMapSceneOut)
async def put_map_scene(
    body: NetworkMapScenePut,
    user: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    scene = normalize_scene(body.scene)
    row = await _default_map_scene(db)
    title = (body.title or "").strip()[:255] or None
    if row is None:
        row = NetworkMapScene(
            title=title or "Карта сети",
            scene_json=dumps_scene(scene),
            updated_by=user.id,
        )
        db.add(row)
    else:
        if title:
            row.title = title
        row.scene_json = dumps_scene(scene)
        row.updated_by = user.id
    await db.commit()
    await db.refresh(row)
    return _scene_out(row)


@router.get("/map-scenes", response_model=list[NetworkMapSceneMeta])
async def list_map_scenes(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(select(NetworkMapScene).order_by(NetworkMapScene.id.asc()))).scalars().all()
    return [_scene_meta(row) for row in rows]


@router.post("/map-scenes", response_model=NetworkMapSceneOut)
async def create_map_scene(
    body: NetworkMapSceneCreate,
    user: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    mode = (body.mode or "blank").strip().lower()
    title = (body.title or "").strip()[:255]
    if mode == "topology":
        topo = await get_topology(user, db)
        from app.network_map_layout import layout_topology_scene

        scene = layout_topology_scene(
            [n.model_dump() for n in topo.nodes],
            [e.model_dump() for e in topo.edges],
        )
        title = title or "Схема по топологии"
    else:
        scene = empty_scene()
        title = title or "Новая схема"
    row = NetworkMapScene(title=title, scene_json=dumps_scene(scene), updated_by=user.id)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _scene_out(row)


@router.get("/map-scenes/{scene_id}", response_model=NetworkMapSceneOut)
async def get_map_scene_by_id(
    scene_id: int,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(NetworkMapScene).where(NetworkMapScene.id == scene_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    return _scene_out(row)


@router.put("/map-scenes/{scene_id}", response_model=NetworkMapSceneOut)
async def put_map_scene_by_id(
    scene_id: int,
    body: NetworkMapScenePut,
    user: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(NetworkMapScene).where(NetworkMapScene.id == scene_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    scene = normalize_scene(body.scene)
    title = (body.title or "").strip()[:255]
    if title:
        row.title = title
    row.scene_json = dumps_scene(scene)
    row.updated_by = user.id
    await db.commit()
    await db.refresh(row)
    return _scene_out(row)


@router.post("/map-scenes/{scene_id}/layout", response_model=NetworkMapSceneOut)
async def layout_map_scene(
    scene_id: int,
    user: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(NetworkMapScene).where(NetworkMapScene.id == scene_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    topo = await get_topology(user, db)
    from app.network_map_layout import layout_topology_scene

    scene = layout_topology_scene(
        [n.model_dump() for n in topo.nodes],
        [e.model_dump() for e in topo.edges],
    )
    row.scene_json = dumps_scene(scene)
    row.updated_by = user.id
    if not (row.title or "").strip() or row.title == "Карта сети":
        row.title = "Схема по топологии"
    await db.commit()
    await db.refresh(row)
    return _scene_out(row)


@router.post("/map-scenes/{scene_id}/trace", response_model=NetworkMapSceneOut)
async def trace_map_scene(
    scene_id: int,
    body: NetworkMapTraceIn,
    user: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(NetworkMapScene).where(NetworkMapScene.id == scene_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    target = (body.target or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="Укажите IP или имя")

    topo = await get_topology(user, db)
    topo_nodes = [n.model_dump() for n in topo.nodes]
    topo_edges = [e.model_dump() for e in topo.edges]
    from app.network_map_layout import (
        _norm_ip,
        merge_trace_into_scene,
        pick_path_start,
        resolve_topology_target,
        shortest_topology_path,
        stored_trace_chain,
    )

    by_id = {str(n["id"]): n for n in topo_nodes}
    by_ip = {_norm_ip(n.get("ip_address")): n for n in topo_nodes if _norm_ip(n.get("ip_address"))}

    devices = (await db.execute(select(NetworkDevice))).scalars().all()
    for device in devices:
        ip = _norm_ip(getattr(device, "ip_address", None))
        if ip and ip not in by_ip:
            by_ip[ip] = {
                "id": f"network_device:{device.id}",
                "kind": "network_device",
                "ref_id": device.id,
                "label": device.hostname or device.sys_name or device.ip_address,
                "device_type": device.device_type,
                "ip_address": device.ip_address,
            }
            by_id[f"network_device:{device.id}"] = by_ip[ip]

    scene = normalize_scene(row.scene_json)
    dest_id = resolve_topology_target(list(by_id.values()), target)
    stored = stored_trace_chain(list(devices), target, by_ip)

    path_nodes: list[dict[str, Any]] = []
    path_edges: list[dict[str, Any]] = []
    if stored:
        path_nodes, path_edges = stored
    else:
        if not dest_id:
            raise HTTPException(status_code=404, detail="Нет известного пути до этого адреса")
        preferred = None
        from_id = (body.from_id or "").strip() or None
        if from_id:
            preferred = from_id if from_id in by_id else None
            if not preferred:
                for node in scene.get("nodes") or []:
                    if not isinstance(node, dict) or str(node.get("id")) != from_id:
                        continue
                    bind = node.get("bind") if isinstance(node.get("bind"), dict) else None
                    if bind and bind.get("type") == "corax":
                        preferred = "corax:self"
                    elif bind and bind.get("type") and bind.get("id") is not None:
                        preferred = f"{bind['type']}:{int(bind['id'])}"
        start_id = pick_path_start(
            list(scene.get("nodes") or []),
            set(by_id),
            preferred=preferred,
            avoid=dest_id,
        )
        if not start_id:
            raise HTTPException(status_code=404, detail="Нет известного пути до этого адреса")
        found = shortest_topology_path(topo_edges, start_id, dest_id)
        if not found:
            raise HTTPException(status_code=404, detail="Нет известного пути до этого адреса")
        ids, used = found
        path_nodes = [by_id[i] for i in ids if i in by_id]
        path_edges = used

    if len(path_nodes) < 2:
        raise HTTPException(status_code=404, detail="Нет известного пути до этого адреса")

    next_scene = merge_trace_into_scene(scene, path_nodes, path_edges, anchor_id=(body.from_id or None))
    row.scene_json = dumps_scene(next_scene)
    row.updated_by = user.id
    await db.commit()
    await db.refresh(row)
    return _scene_out(row)


@router.delete("/map-scenes/{scene_id}", status_code=204)
async def delete_map_scene(
    scene_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(NetworkMapScene).where(NetworkMapScene.id == scene_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    await db.delete(row)
    await db.commit()
    return None


@router.post("/map-live", response_model=MapLiveOut)
async def map_live(
    body: MapLiveIn,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    wanted: dict[tuple[str, int], None] = {}
    for raw in body.binds:
        btype = (raw.type or "").strip().lower()
        if btype not in BIND_TYPES:
            continue
        wanted[(btype, int(raw.id))] = None
    if not wanted:
        return MapLiveOut(items=[])

    device_ids = [i for t, i in wanted if t == "network_device"]
    computer_ids = [i for t, i in wanted if t == "computer"]
    printer_ids = [i for t, i in wanted if t == "printer"]
    zabbix_ids = [i for t, i in wanted if t == "zabbix"]

    found: dict[tuple[str, int], MapLiveItem] = {}

    if device_ids:
        rows = (
            await db.execute(
                select(
                    NetworkDevice.id,
                    NetworkDevice.hostname,
                    NetworkDevice.sys_name,
                    NetworkDevice.ip_address,
                    NetworkDevice.vendor,
                    NetworkDevice.snmp_status,
                    NetworkDevice.interfaces_json,
                    NetworkDevice.extras_json,
                ).where(NetworkDevice.id.in_(device_ids))
            )
        ).all()
        for row in rows:
            extras = _parse_extras(row.extras_json)
            interfaces = _parse_json_list(row.interfaces_json)
            found[("network_device", int(row.id))] = MapLiveItem(
                type="network_device",
                id=int(row.id),
                label=(row.hostname or row.sys_name or row.ip_address),
                ip=row.ip_address,
                vendor=row.vendor,
                status=row.snmp_status,
                missing=False,
                port_count=_port_count_from(extras, interfaces),
                ports=_switch_ports(interfaces, extras),
            )

    if computer_ids:
        rows = (
            await db.execute(
                select(
                    Computer.id,
                    Computer.hostname,
                    Computer.ip_address,
                    Computer.manufacturer,
                    Computer.ping_status,
                ).where(Computer.id.in_(computer_ids))
            )
        ).all()
        for row in rows:
            found[("computer", int(row.id))] = MapLiveItem(
                type="computer",
                id=int(row.id),
                label=row.hostname,
                ip=row.ip_address,
                vendor=row.manufacturer,
                status=row.ping_status,
                missing=False,
            )

    if printer_ids:
        rows = (
            await db.execute(
                select(
                    Printer.id,
                    Printer.name,
                    Printer.ip_address,
                    Printer.snmp_model,
                    Printer.poll_status,
                    Printer.snmp_status,
                ).where(Printer.id.in_(printer_ids))
            )
        ).all()
        for row in rows:
            found[("printer", int(row.id))] = MapLiveItem(
                type="printer",
                id=int(row.id),
                label=row.name or row.ip_address,
                ip=row.ip_address,
                vendor=row.snmp_model,
                status=row.poll_status or row.snmp_status,
                missing=False,
            )

    if ("corax", 0) in wanted:
        found[("corax", 0)] = MapLiveItem(
            type="corax",
            id=0,
            label="Corax",
            ip=None,
            vendor="CORAX",
            status="ok",
            missing=False,
        )

    if zabbix_ids:
        try:
            from app.zabbix_service import get_hosts_payload

            payload = await get_hosts_payload(db, limit=500)
            hosts = payload.get("items") if isinstance(payload, dict) else None
            by_id: dict[int, dict[str, Any]] = {}
            if isinstance(hosts, list):
                for host in hosts:
                    if not isinstance(host, dict):
                        continue
                    try:
                        hid = int(str(host.get("hostid") or ""))
                    except (TypeError, ValueError):
                        continue
                    by_id[hid] = host
            for hid in zabbix_ids:
                host = by_id.get(hid)
                if not host:
                    continue
                enabled = int(host.get("status") or 0) == 0
                found[("zabbix", hid)] = MapLiveItem(
                    type="zabbix",
                    id=hid,
                    label=(host.get("name") or host.get("host") or str(hid)),
                    ip=(host.get("ip") or None),
                    vendor="Zabbix",
                    status="ok" if enabled else "offline",
                    missing=False,
                )
        except Exception:
            pass

    items: list[MapLiveItem] = []
    for key in wanted:
        hit = found.get(key)
        if hit is not None:
            items.append(hit)
        else:
            items.append(MapLiveItem(type=key[0], id=key[1], missing=True))
    return MapLiveOut(items=items)


@router.post("/links", response_model=NetworkLinkOut)
async def create_manual_link(
    body: NetworkLinkCreate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    from_type = (body.from_type or "").strip().lower()
    to_type = (body.to_type or "").strip().lower()
    if from_type not in LINK_ENDPOINT_TYPES or to_type not in LINK_ENDPOINT_TYPES:
        raise HTTPException(status_code=400, detail="Некорректный тип узла связи")
    if from_type == to_type and body.from_id == body.to_id:
        raise HTTPException(status_code=400, detail="Нельзя связать узел с самим собой")
    await _ensure_link_endpoint(db, from_type, body.from_id)
    await _ensure_link_endpoint(db, to_type, body.to_id)

    existing = (
        await db.execute(
            select(NetworkLink).where(
                NetworkLink.from_type == from_type,
                NetworkLink.from_id == body.from_id,
                NetworkLink.to_type == to_type,
                NetworkLink.to_id == body.to_id,
                NetworkLink.link_type == "manual",
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        existing = (
            await db.execute(
                select(NetworkLink).where(
                    NetworkLink.from_type == to_type,
                    NetworkLink.from_id == body.to_id,
                    NetworkLink.to_type == from_type,
                    NetworkLink.to_id == body.from_id,
                    NetworkLink.link_type == "manual",
                )
            )
        ).scalar_one_or_none()
    if existing:
        existing.local_port = (body.local_port or "").strip()[:128] or None
        existing.remote_port = (body.remote_port or "").strip()[:128] or None
        await db.commit()
        await db.refresh(existing)
        return _link_out(existing)

    row = NetworkLink(
        from_type=from_type,
        from_id=int(body.from_id),
        to_type=to_type,
        to_id=int(body.to_id),
        link_type="manual",
        local_port=(body.local_port or "").strip()[:128] or None,
        remote_port=(body.remote_port or "").strip()[:128] or None,
        confidence=1.0,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _link_out(row)


@router.delete("/links/{link_id}", status_code=204)
async def delete_manual_link(
    link_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(NetworkLink).where(NetworkLink.id == link_id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Связь не найдена")
    if (row.link_type or "").lower() in AUTO_LINK_TYPES:
        raise HTTPException(status_code=400, detail="Автосвязь нельзя удалить вручную")
    if (row.link_type or "").lower() != "manual":
        raise HTTPException(status_code=400, detail="Можно удалять только ручные связи")
    await db.delete(row)
    await db.commit()
    return None
