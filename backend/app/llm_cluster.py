"""Store llama.cpp samples and build the cluster snapshot.

GPU rows arrive inside the existing audit report. Prometheus series are
scraped here, on the API host, from the URL configured for that node.
Nothing in this module assumes the API machine has an NVIDIA GPU.
"""

from __future__ import annotations

import asyncio
import http.client
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.llm_metrics import (
    build_health,
    derive_layers,
    gpu_rows_from_payload,
    parse_llamacpp_metrics,
    parse_rpc_ports,
    service_url,
)
from app.models import (
    Computer,
    LlmClusterNode,
    LlmControlAudit,
    LlmGpuSample,
    LlmMetricSample,
    ServerAuditHost,
    ServerAuditJob,
    User,
)
from app.server_audit_jobs import enqueue_job
from app.server_audit_store import find_audit_host, interval_seconds_of

log = logging.getLogger("corax.llm")

_GPU_CAP = 8000
_METRIC_CAP = 8000
_SERIES_LIMIT = 180
SCRAPE_SECONDS = 15


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    moment = _utc(value)
    if moment is None:
        return None
    return moment.isoformat()


async def _prune_rows(db: AsyncSession, model, column, owner_column, owner_id: int, now: datetime, cap: int) -> None:
    cutoff = now - timedelta(days=14)
    await db.execute(delete(model).where(owner_column == owner_id, column < cutoff))
    count = int(
        await db.scalar(select(func.count()).select_from(model).where(owner_column == owner_id)) or 0
    )
    extra = count - cap
    if extra <= 0:
        return
    old_ids = list(
        (
            await db.execute(
                select(model.id).where(owner_column == owner_id).order_by(column.asc()).limit(extra)
            )
        ).scalars().all()
    )
    if old_ids:
        await db.execute(delete(model).where(model.id.in_(old_ids)))


async def record_llm_telemetry(
    db: AsyncSession, host_id: int, collected_at: datetime, payload: dict[str, Any]
) -> None:
    """Persist GPUs from an audit sample and the agent's RPC probe, if a node exists."""
    moment = _utc(collected_at) or datetime.now(timezone.utc)
    rows = gpu_rows_from_payload(payload if isinstance(payload, dict) else {})
    for row in rows:
        db.add(
            LlmGpuSample(
                host_id=host_id,
                collected_at=moment,
                gpu_index=int(row["gpu_index"]),
                name=row["name"],
                util_percent=row["util_percent"],
                mem_used_mb=row["mem_used_mb"],
                mem_total_mb=row["mem_total_mb"],
                temp_c=row["temp_c"],
                power_w=row["power_w"],
            )
        )
    if rows:
        await _prune_rows(db, LlmGpuSample, LlmGpuSample.collected_at, LlmGpuSample.host_id, host_id, moment, _GPU_CAP)
    node = (
        await db.execute(select(LlmClusterNode).where(LlmClusterNode.host_id == host_id))
    ).scalar_one_or_none()
    blob = payload.get("llm") if isinstance(payload, dict) else None
    if node is not None and isinstance(blob, dict):
        node.agent_llm_json = json.dumps(
            {"rpc": blob.get("rpc") or [], "units": blob.get("units") or []},
            ensure_ascii=False,
        )[:8000]


async def apply_llm_job_result(db: AsyncSession, job_id: int) -> None:
    job = await db.get(ServerAuditJob, job_id)
    if job is None:
        return
    node = (
        await db.execute(select(LlmClusterNode).where(LlmClusterNode.host_id == job.host_id))
    ).scalar_one_or_none()
    if node is None:
        return
    output = job.output or ""
    if job.action == "models" and job.status == "done" and output:
        try:
            data = json.loads(output)
        except json.JSONDecodeError:
            return
        models = data.get("models") if isinstance(data, dict) else None
        if isinstance(models, list):
            node.latest_models_json = json.dumps(models[:200], ensure_ascii=False)[:60000]
        return
    if job.action == "journal" and output:
        layers = derive_layers(output, _saved_apply(node))
        if layers.get("source") == "journal":
            node.latest_layers_json = json.dumps(layers, ensure_ascii=False)
        return
    if job.action == "rpc-probe" and job.status == "done" and output:
        node.latest_rpc_json = output[:20000]
        return
    if job.action == "llama-apply":
        spec = _saved_apply_body(job.body)
        if spec.get("model"):
            node.latest_model = str(spec["model"])[:512]
        node.latest_apply_json = json.dumps(spec, ensure_ascii=False)[:4000]
        current = _loads(node.latest_layers_json)
        if current.get("source") != "journal":
            node.latest_layers_json = json.dumps(derive_layers(None, spec), ensure_ascii=False)


def _loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _saved_apply(node: LlmClusterNode) -> dict[str, Any]:
    return _loads(node.latest_apply_json)


def _saved_apply_body(body: str | None) -> dict[str, Any]:
    data = _loads(body)
    return data


def _fetch_text(url: str, timeout: float, limit: int, method: str = "GET", payload: bytes | None = None) -> tuple[int, str]:
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    if parts.scheme == "https":
        conn: http.client.HTTPConnection = http.client.HTTPSConnection(parts.hostname, port, timeout=timeout)
    else:
        conn = http.client.HTTPConnection(parts.hostname, port, timeout=timeout)
    headers = {"User-Agent": "corax-llm", "Accept": "application/json, text/plain"}
    body = payload
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        # Do not follow redirects: the next host was not on the allowlist.
        status = int(resp.status)
        data = resp.read(limit + 1)
    finally:
        conn.close()
    if len(data) > limit:
        data = data[:limit]
    return status, data.decode("utf-8", errors="replace")


async def scrape_metrics(db: AsyncSession) -> dict[str, int]:
    nodes = list((await db.execute(select(LlmClusterNode))).scalars().all())
    stored = 0
    failed = 0
    now = datetime.now(timezone.utc)
    for node in nodes:
        host = await db.get(ServerAuditHost, node.host_id)
        if host is None or not node.metrics_url:
            continue
        ip = await _host_ip(db, host)
        url = service_url(node.metrics_url, hostname=host.hostname, ip=ip, kind="metrics")
        if url is None:
            node.latest_metrics_ok = False
            failed += 1
            continue
        try:
            status, text = await asyncio.to_thread(_fetch_text, url, 4.0, 256_000)
        except Exception as exc:
            log.info("llama metrics scrape failed for %s: %s", host.hostname, exc)
            node.latest_metrics_ok = False
            failed += 1
            continue
        parsed = parse_llamacpp_metrics(text) if status == 200 else {}
        if not parsed:
            node.latest_metrics_ok = False
            failed += 1
            continue
        db.add(
            LlmMetricSample(
                node_id=node.id,
                collected_at=now,
                prompt_tokens_seconds=parsed.get("prompt_tokens_seconds"),
                predicted_tokens_seconds=parsed.get("predicted_tokens_seconds"),
                tokens_predicted_total=parsed.get("tokens_predicted_total"),
                prompt_tokens_total=parsed.get("prompt_tokens_total"),
            )
        )
        node.latest_metrics_at = now
        node.latest_metrics_ok = True
        stored += 1
        await _prune_rows(
            db, LlmMetricSample, LlmMetricSample.collected_at, LlmMetricSample.node_id, node.id, now, _METRIC_CAP
        )
    return {"stored": stored, "failed": failed}


async def _host_ip(db: AsyncSession, host: ServerAuditHost) -> str | None:
    if not host.computer_id:
        return None
    row = await db.get(Computer, host.computer_id)
    if row is None:
        return None
    return row.ip_address


async def _latest_gpus(db: AsyncSession, host_id: int) -> list[LlmGpuSample]:
    latest = await db.scalar(
        select(func.max(LlmGpuSample.collected_at)).where(LlmGpuSample.host_id == host_id)
    )
    if latest is None:
        return []
    return list(
        (
            await db.execute(
                select(LlmGpuSample)
                .where(LlmGpuSample.host_id == host_id, LlmGpuSample.collected_at == latest)
                .order_by(LlmGpuSample.gpu_index.asc())
            )
        ).scalars().all()
    )


def _gpu_public(row: LlmGpuSample) -> dict[str, Any]:
    return {
        "index": row.gpu_index,
        "name": row.name,
        "util_percent": row.util_percent,
        "mem_used_mb": row.mem_used_mb,
        "mem_total_mb": row.mem_total_mb,
        "temp_c": row.temp_c,
        "power_w": row.power_w,
        "collected_at": _iso(row.collected_at),
    }


def _rpc_view(node: LlmClusterNode, gpus: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ports = parse_rpc_ports(node.rpc_ports)
    probe = _loads(node.latest_rpc_json)
    agent = _loads(node.agent_llm_json)
    probe_ports = {int(row["port"]): row for row in probe.get("ports") or [] if isinstance(row, dict) and str(row.get("port", "")).isdigit()}
    agent_ports = {int(row["port"]): row for row in agent.get("rpc") or [] if isinstance(row, dict) and str(row.get("port", "")).isdigit()}
    units = {}
    for source in (probe.get("units") or [], agent.get("units") or []):
        if not isinstance(source, list):
            continue
        for row in source:
            if isinstance(row, dict) and row.get("unit"):
                units[str(row["unit"])] = row
    vram_total = sum(float(gpu["mem_total_mb"]) for gpu in gpus if gpu.get("mem_total_mb") is not None)
    vram_used = sum(float(gpu["mem_used_mb"]) for gpu in gpus if gpu.get("mem_used_mb") is not None)
    rows = []
    for index, port in enumerate(ports):
        unit = f"rpc-server-gpu{index}" if index <= 7 else "rpc-server"
        heard = probe_ports.get(port) or agent_ports.get(port) or {}
        unit_row = units.get(unit) or units.get("rpc-server") or {}
        rows.append(
            {
                "unit": unit,
                "port": port,
                "listening": heard.get("listening"),
                "active": unit_row.get("active"),
                "vram_total_mb": round(vram_total, 1) if index == 0 and vram_total else None,
                "vram_used_mb": round(vram_used, 1) if index == 0 and vram_used else None,
            }
        )
    return rows


async def cluster_snapshot(db: AsyncSession) -> dict[str, Any]:
    nodes = list((await db.execute(select(LlmClusterNode).order_by(LlmClusterNode.id.asc()))).scalars().all())
    now = datetime.now(timezone.utc)
    public_nodes: list[dict[str, Any]] = []
    central_id = None
    for node in nodes:
        host = await db.get(ServerAuditHost, node.host_id)
        if host is None:
            continue
        if node.role == "central" and central_id is None:
            central_id = node.id
        gpus = [_gpu_public(row) for row in await _latest_gpus(db, host.id)]
        age = None
        metrics_at = _utc(node.latest_metrics_at)
        if metrics_at is not None:
            age = max(0, int((now - metrics_at).total_seconds()))
        sample_age = None
        last_sample = _utc(host.last_sample_at)
        if last_sample is not None:
            sample_age = max(0, int((now - last_sample).total_seconds()))
        limit = max(90, interval_seconds_of(host) * 3)
        online = sample_age is not None and sample_age <= limit
        speeds = await _latest_speeds(db, node.id)
        layers = _loads(node.latest_layers_json)
        if not layers:
            layers = derive_layers(None, _saved_apply(node))
        models = []
        try:
            parsed_models = json.loads(node.latest_models_json or "[]")
            if isinstance(parsed_models, list):
                models = parsed_models[:200]
        except json.JSONDecodeError:
            models = []
        public_nodes.append(
            {
                "id": node.id,
                "host_id": host.id,
                "hostname": host.hostname,
                "label": host.label,
                "ip_address": await _host_ip(db, host),
                "role": node.role if node.role in {"central", "worker"} else "worker",
                "online": online,
                "sample_age_sec": sample_age,
                "metrics_url": node.metrics_url,
                "chat_base_url": node.chat_base_url,
                "rpc_ports": parse_rpc_ports(node.rpc_ports),
                "model_dir": node.model_dir,
                "model": node.latest_model,
                "metrics_configured": bool(node.metrics_url),
                "metrics_ok": bool(node.latest_metrics_ok),
                "metrics_age_sec": age,
                "speeds": speeds,
                "layers": layers,
                "gpus": gpus,
                "rpc": _rpc_view(node, gpus),
                "models": models,
                "gpu_series": await _gpu_series(db, host.id),
            }
        )
    if central_id is None and public_nodes:
        central_id = public_nodes[0]["id"]
    vram_used = 0.0
    vram_total = 0.0
    for node in public_nodes:
        for gpu in node["gpus"]:
            if gpu.get("mem_used_mb") is not None:
                vram_used += float(gpu["mem_used_mb"])
            if gpu.get("mem_total_mb") is not None:
                vram_total += float(gpu["mem_total_mb"])
    central = next((node for node in public_nodes if node["id"] == central_id), None)
    series = await _speed_series(db, central_id) if central_id else []
    gpu_series = await _gpu_series(db, central["host_id"]) if central else []
    health = build_health(public_nodes, now)
    return {
        "nodes": public_nodes,
        "aggregate": {
            "vram_used_mb": round(vram_used, 1),
            "vram_total_mb": round(vram_total, 1),
            "nodes_online": sum(1 for node in public_nodes if node["online"]),
            "nodes_total": len(public_nodes),
            "model": central.get("model") if central else None,
            "status": health["status"],
            "predicted_tokens_seconds": (central or {}).get("speeds", {}).get("predicted_tokens_seconds"),
            "prompt_tokens_seconds": (central or {}).get("speeds", {}).get("prompt_tokens_seconds"),
        },
        "series": series,
        "gpu_series": gpu_series,
        "health": health,
    }


async def _latest_speeds(db: AsyncSession, node_id: int) -> dict[str, float | None]:
    row = (
        await db.execute(
            select(LlmMetricSample)
            .where(LlmMetricSample.node_id == node_id)
            .order_by(LlmMetricSample.collected_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        return {
            "prompt_tokens_seconds": None,
            "predicted_tokens_seconds": None,
            "tokens_predicted_total": None,
            "prompt_tokens_total": None,
        }
    return {
        "prompt_tokens_seconds": row.prompt_tokens_seconds,
        "predicted_tokens_seconds": row.predicted_tokens_seconds,
        "tokens_predicted_total": row.tokens_predicted_total,
        "prompt_tokens_total": row.prompt_tokens_total,
    }


async def _speed_series(db: AsyncSession, node_id: int) -> list[dict[str, Any]]:
    since = datetime.now(timezone.utc) - timedelta(minutes=60)
    rows = list(
        (
            await db.execute(
                select(LlmMetricSample)
                .where(LlmMetricSample.node_id == node_id, LlmMetricSample.collected_at >= since)
                .order_by(LlmMetricSample.collected_at.desc())
                .limit(_SERIES_LIMIT)
            )
        ).scalars().all()
    )
    rows.reverse()
    return [
        {
            "t": _iso(row.collected_at),
            "prompt_tokens_seconds": row.prompt_tokens_seconds,
            "predicted_tokens_seconds": row.predicted_tokens_seconds,
        }
        for row in rows
    ]


async def _gpu_series(db: AsyncSession, host_id: int) -> list[dict[str, Any]]:
    since = datetime.now(timezone.utc) - timedelta(minutes=60)
    rows = list(
        (
            await db.execute(
                select(LlmGpuSample)
                .where(LlmGpuSample.host_id == host_id, LlmGpuSample.collected_at >= since)
                .order_by(LlmGpuSample.collected_at.desc())
                .limit(_SERIES_LIMIT * 4)
            )
        ).scalars().all()
    )
    rows.reverse()
    return [
        {
            "t": _iso(row.collected_at),
            "index": row.gpu_index,
            "util_percent": row.util_percent,
            "mem_used_mb": row.mem_used_mb,
            "temp_c": row.temp_c,
            "power_w": row.power_w,
        }
        for row in rows
    ]


async def list_audit_hosts(db: AsyncSession) -> list[dict[str, Any]]:
    hosts = list((await db.execute(select(ServerAuditHost).order_by(ServerAuditHost.hostname.asc()))).scalars().all())
    out = []
    for host in hosts:
        out.append(
            {
                "id": host.id,
                "hostname": host.hostname,
                "label": host.label,
                "enabled": bool(host.enabled),
                "ip_address": await _host_ip(db, host),
                "last_sample_at": _iso(host.last_sample_at),
            }
        )
    return out


async def upsert_node(db: AsyncSession, host: ServerAuditHost, body: dict[str, Any]) -> LlmClusterNode:
    role = str(body.get("role") or "worker").strip().lower()
    if role not in {"central", "worker"}:
        raise ValueError("Роль узла: central или worker")
    ip = await _host_ip(db, host)
    metrics = body.get("metrics_url")
    chat = body.get("chat_base_url")
    metrics_url = None
    chat_url = None
    if metrics:
        metrics_url = service_url(str(metrics), hostname=host.hostname, ip=ip, kind="metrics")
        if metrics_url is None:
            raise ValueError("URL метрик должен указывать на hostname или IP этого узла и путь /metrics")
    if chat:
        chat_url = service_url(str(chat), hostname=host.hostname, ip=ip, kind="chat")
        if chat_url is None:
            raise ValueError("URL чата должен указывать на hostname или IP этого узла")
    ports = parse_rpc_ports(str(body.get("rpc_ports") or ""))
    if not ports:
        raise ValueError("Порты RPC: числа 1024–65535 через запятую")
    from app.llm_metrics import model_dir_allowed

    model_dir = model_dir_allowed(str(body.get("model_dir") or "/models"))
    if model_dir is None:
        raise ValueError("Каталог моделей вне списка разрешённых")
    node = (
        await db.execute(select(LlmClusterNode).where(LlmClusterNode.host_id == host.id))
    ).scalar_one_or_none()
    if node is None:
        node = LlmClusterNode(host_id=host.id)
        db.add(node)
    node.role = role
    node.metrics_url = metrics_url
    node.chat_base_url = chat_url
    node.rpc_ports = ",".join(str(port) for port in ports)
    node.model_dir = model_dir
    await db.flush()
    return node


async def remove_node(db: AsyncSession, node_id: int) -> bool:
    node = await db.get(LlmClusterNode, node_id)
    if node is None:
        return False
    await db.delete(node)
    await db.flush()
    return True


async def queue_control(
    db: AsyncSession,
    *,
    user: User,
    node: LlmClusterNode,
    host: ServerAuditHost,
    action: str,
    target: str,
    body: str | None,
    params: dict[str, Any],
) -> ServerAuditJob:
    job = await enqueue_job(db, host, user_id=user.id, action=action, target=target, body=body)
    if params:
        row = (
            await db.execute(select(LlmControlAudit).where(LlmControlAudit.job_id == job.id))
        ).scalar_one_or_none()
        if row is not None:
            row.node_id = node.id
            row.params_json = json.dumps(params, ensure_ascii=False)[:4000]
    await db.flush()
    return job


async def list_control_audit(db: AsyncSession, limit: int = 40) -> list[dict[str, Any]]:
    rows = list(
        (
            await db.execute(select(LlmControlAudit).order_by(LlmControlAudit.id.desc()).limit(limit))
        ).scalars().all()
    )
    return [
        {
            "id": row.id,
            "username": row.username,
            "host_id": row.host_id,
            "node_id": row.node_id,
            "action": row.action,
            "target": row.target,
            "params": _loads(row.params_json),
            "job_id": row.job_id,
            "created_at": _iso(row.created_at),
        }
        for row in rows
    ]


def chat_target(node: LlmClusterNode, hostname: str, ip: str | None) -> str | None:
    base = node.chat_base_url
    if not base and node.metrics_url:
        metrics = service_url(node.metrics_url, hostname=hostname, ip=ip, kind="metrics")
        if metrics and metrics.endswith("/metrics"):
            base = metrics[: -len("/metrics")]
    if not base:
        return None
    origin = service_url(base if "://" in base else None, hostname=hostname, ip=ip, kind="chat") if base.startswith("http") else None
    if origin is None and node.chat_base_url:
        origin = service_url(node.chat_base_url, hostname=hostname, ip=ip, kind="chat")
    if origin is None:
        return None
    return origin.rstrip("/") + "/v1/chat/completions"


def complete_chat(url: str, messages: list[dict[str, str]], temperature: float | None, max_tokens: int | None) -> tuple[int, str]:
    payload: dict[str, Any] = {"messages": messages, "stream": False}
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    return _fetch_text(url, 90.0, 400_000, method="POST", payload=json.dumps(payload).encode("utf-8"))


class LlmScrapeScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="llm-metrics-scrape")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                async with AsyncSessionLocal() as db:
                    await scrape_metrics(db)
                    await db.commit()
            except Exception as exc:
                log.warning("llm scrape: %s", exc)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=SCRAPE_SECONDS)
            except asyncio.TimeoutError:
                pass


llm_scrape_scheduler = LlmScrapeScheduler()


async def node_for_host_name(db: AsyncSession, hostname: str) -> LlmClusterNode | None:
    host = await find_audit_host(db, hostname)
    if host is None:
        return None
    return (
        await db.execute(select(LlmClusterNode).where(LlmClusterNode.host_id == host.id))
    ).scalar_one_or_none()
