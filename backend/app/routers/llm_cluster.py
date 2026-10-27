"""LLM cluster API. Control is queued for the audit agent; the browser never opens SSH."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import can_access_panel
from app.database import AsyncSessionLocal, get_db
from app.diagram_live import user_from_access_token
from app.llm_access import can_view_llm, get_current_llm_operator, get_current_llm_viewer
from app.llm_cluster import (
    chat_target,
    cluster_snapshot,
    complete_chat,
    list_audit_hosts,
    list_control_audit,
    queue_control,
    remove_node,
    scrape_metrics,
    upsert_node,
)
from app.llm_metrics import build_health, parse_llama_apply
from app.server_audit_jobs import list_jobs

router = APIRouter(prefix="/llm", tags=["llm"])


class NodeBody(BaseModel):
    host_id: int
    role: str = "worker"
    metrics_url: str | None = None
    chat_base_url: str | None = None
    rpc_ports: str = "50052,50053"
    model_dir: str = "/models"


class NodePatch(BaseModel):
    role: str | None = None
    metrics_url: str | None = None
    chat_base_url: str | None = None
    rpc_ports: str | None = None
    model_dir: str | None = None


class ControlBody(BaseModel):
    action: str = Field(min_length=1, max_length=32)
    target: str = Field(default="", max_length=255)
    body: str | None = Field(default=None, max_length=4000)


class ChatMessage(BaseModel):
    role: str
    content: str = Field(max_length=8000)


class ChatBody(BaseModel):
    node_id: int
    messages: list[ChatMessage] = Field(min_length=1, max_length=16)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=4096)


def _health_parts(snap: dict) -> dict:
    health = snap.get("health")
    if isinstance(health, dict) and "llama" in health and "rpc" in health:
        return health
    return build_health(snap.get("nodes") or [])


async def _node_or_404(db: AsyncSession, node_id: int) -> tuple[LlmClusterNode, ServerAuditHost]:
    node = await db.get(LlmClusterNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Узел LLM не найден")
    host = await db.get(ServerAuditHost, node.host_id)
    if host is None:
        raise HTTPException(status_code=404, detail="Хост аудита не найден")
    return node, host


@router.get("/cluster")
async def llm_cluster(_: User = Depends(get_current_llm_viewer), db: AsyncSession = Depends(get_db)):
    return await cluster_snapshot(db)


@router.get("/health")
async def llm_health(_: User = Depends(get_current_llm_viewer), db: AsyncSession = Depends(get_db)):
    return _health_parts(await cluster_snapshot(db))


@router.get("/health/llama")
async def llm_health_llama(_: User = Depends(get_current_llm_viewer), db: AsyncSession = Depends(get_db)):
    health = _health_parts(await cluster_snapshot(db))
    return {"status": health["status"], "llama": health["llama"]}


@router.get("/health/rpc")
async def llm_health_rpc(_: User = Depends(get_current_llm_viewer), db: AsyncSession = Depends(get_db)):
    health = _health_parts(await cluster_snapshot(db))
    return {"status": health["status"], "rpc": health["rpc"]}


@router.get("/audit-hosts")
async def llm_audit_hosts(_: User = Depends(get_current_llm_operator), db: AsyncSession = Depends(get_db)):
    return await list_audit_hosts(db)


@router.get("/audit")
async def llm_audit(_: User = Depends(get_current_llm_viewer), db: AsyncSession = Depends(get_db)):
    return await list_control_audit(db)


@router.post("/nodes")
async def llm_node_create(
    body: NodeBody,
    _: User = Depends(get_current_llm_operator),
    db: AsyncSession = Depends(get_db),
):
    host = await db.get(ServerAuditHost, body.host_id)
    if host is None:
        raise HTTPException(status_code=404, detail="Хост аудита не найден")
    try:
        node = await upsert_node(db, host, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    return {"id": node.id, "host_id": node.host_id, "role": node.role}


@router.patch("/nodes/{node_id}")
async def llm_node_update(
    node_id: int,
    body: NodePatch,
    _: User = Depends(get_current_llm_operator),
    db: AsyncSession = Depends(get_db),
):
    node, host = await _node_or_404(db, node_id)
    current = {
        "role": node.role,
        "metrics_url": node.metrics_url,
        "chat_base_url": node.chat_base_url,
        "rpc_ports": node.rpc_ports,
        "model_dir": node.model_dir,
    }
    patch = body.model_dump(exclude_unset=True)
    current.update(patch)
    current["host_id"] = host.id
    try:
        saved = await upsert_node(db, host, current)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    return {"id": saved.id, "host_id": saved.host_id, "role": saved.role}


@router.delete("/nodes/{node_id}")
async def llm_node_delete(
    node_id: int,
    _: User = Depends(get_current_llm_operator),
    db: AsyncSession = Depends(get_db),
):
    if not await remove_node(db, node_id):
        raise HTTPException(status_code=404, detail="Узел LLM не найден")
    await db.commit()
    return {"ok": True}


@router.get("/nodes/{node_id}/jobs")
async def llm_node_jobs(
    node_id: int,
    _: User = Depends(get_current_llm_operator),
    db: AsyncSession = Depends(get_db),
):
    _node, host = await _node_or_404(db, node_id)
    return await list_jobs(db, host.id, limit=15)


@router.post("/nodes/{node_id}/jobs")
async def llm_node_job(
    node_id: int,
    body: ControlBody,
    user: User = Depends(get_current_llm_operator),
    db: AsyncSession = Depends(get_db),
):
    node, host = await _node_or_404(db, node_id)
    if not host.enabled:
        raise HTTPException(status_code=400, detail="Сбор на этом хосте выключен, агент задания не заберёт")
    action = body.action.strip().lower()
    target = body.target
    payload = body.body
    params: dict = {"action": action, "target": target}
    if action == "llama-apply":
        spec, reason = parse_llama_apply(payload)
        if reason or spec is None:
            raise HTTPException(status_code=400, detail=reason or "Параметры отклонены")
        payload = json.dumps(spec, ensure_ascii=False)
        target = "llama-server"
        params = spec
    elif action == "models" and not target.strip():
        target = node.model_dir or "/models"
    elif action == "rpc-probe":
        target = "rpc"
        if not payload:
            ports = [int(part) for part in (node.rpc_ports or "").split(",") if part.strip().isdigit()]
            payload = json.dumps({"ports": ports or [50052, 50053]})
        params = {"ports": payload}
    try:
        job = await queue_control(
            db,
            user=user,
            node=node,
            host=host,
            action=action,
            target=target,
            body=payload,
            params=params,
        )
    except ValueError as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await db.commit()
    return {"id": job.id, "action": job.action, "target": job.target, "status": job.status}


@router.post("/scrape")
async def llm_scrape(_: User = Depends(get_current_llm_operator), db: AsyncSession = Depends(get_db)):
    counts = await scrape_metrics(db)
    await db.commit()
    return counts


@router.post("/chat")
async def llm_chat(
    body: ChatBody,
    _: User = Depends(get_current_llm_operator),
    db: AsyncSession = Depends(get_db),
):
    node, host = await _node_or_404(db, body.node_id)
    from app.llm_cluster import _host_ip

    ip = await _host_ip(db, host)
    url = chat_target(node, host.hostname, ip)
    if url is None:
        raise HTTPException(status_code=400, detail="У узла не задан адрес llama-server")
    messages = []
    for message in body.messages:
        role = message.role.strip().lower()
        if role not in {"system", "user", "assistant"}:
            raise HTTPException(status_code=400, detail="Роль сообщения: system, user или assistant")
        content = message.content.strip()
        if not content:
            continue
        messages.append({"role": role, "content": content})
    if not messages or not any(item["role"] == "user" for item in messages):
        raise HTTPException(status_code=400, detail="Нужно сообщение пользователя")
    try:
        status, text = await asyncio.to_thread(
            complete_chat, url, messages, body.temperature, body.max_tokens
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail="llama-server недоступен") from exc
    if status != 200:
        raise HTTPException(status_code=502, detail=f"llama-server ответил {status}")
    try:
        data = json.loads(text)
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="Ответ llama-server не похож на chat completion") from exc
    if not isinstance(content, str):
        content = str(content)
    return {"content": content[:20000], "model": node.latest_model}


@router.websocket("/live")
async def llm_live(websocket: WebSocket):
    await websocket.accept()
    user = await user_from_access_token(websocket.cookies.get("access_token"))
    if user is None or not can_access_panel(user) or not can_view_llm(user):
        await websocket.close(code=4401)
        return
    try:
        while True:
            async with AsyncSessionLocal() as db:
                snap = await cluster_snapshot(db)
            await websocket.send_text(json.dumps(snap, ensure_ascii=False))
            await asyncio.sleep(5)
    except WebSocketDisconnect:
        return
    except Exception:
        await websocket.close(code=1011)
