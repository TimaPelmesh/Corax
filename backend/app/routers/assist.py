from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.assist_hub import MAX_FRAME_BYTES, WAIT_OFFER_SEC, hub
from app.auth import get_current_editor_or_superuser
from app.database import get_db
from app.diagram_live import user_from_access_token
from app.models import User
from app.routers.agent import verify_agent_token

router = APIRouter(prefix="/assist", tags=["assist"])


class AssistStartBody(BaseModel):
    hostname: str = Field(min_length=1, max_length=255)


class AssistAnswerBody(BaseModel):
    accept: bool
    hostname: str = Field(min_length=1, max_length=255)


def _display_name(user: User) -> str:
    name = (user.full_name or "").strip()
    return name or (user.username or "").strip() or "администратор"


@router.post("/sessions")
async def start_session(body: AssistStartBody, current: User = Depends(get_current_editor_or_superuser)):
    try:
        sess = await hub.create(body.hostname, current.id, _display_name(current))
    except ValueError:
        raise HTTPException(status_code=400, detail="Нужно имя компьютера") from None
    except RuntimeError:
        raise HTTPException(status_code=409, detail="На этом ПК уже идёт Assist") from None
    return hub.public(sess)


@router.get("/pending")
async def pending_offer(
    request: Request,
    hostname: str = Query(min_length=1, max_length=255),
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(None),
):
    _ = request
    await verify_agent_token(db, authorization, hostname)
    sess = await hub.wait_offer(hostname, WAIT_OFFER_SEC)
    if sess is None:
        return {"id": None, "status": "idle"}
    return hub.public(sess)


@router.post("/sessions/{session_id}/answer")
async def answer_session(
    session_id: str,
    body: AssistAnswerBody,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(None),
):
    await verify_agent_token(db, authorization, body.hostname)
    sess = await hub.answer(session_id, body.hostname, body.accept)
    if sess is None:
        raise HTTPException(status_code=404, detail="Сессия Assist не найдена")
    return hub.public(sess)


@router.post("/sessions/{session_id}/end")
async def end_session_admin(session_id: str, current: User = Depends(get_current_editor_or_superuser)):
    _ = current
    sess = await hub.end(session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="Сессия Assist не найдена")
    return hub.public(sess)


@router.post("/sessions/{session_id}/hangup")
async def hangup_session_agent(
    session_id: str,
    hostname: str = Query(min_length=1, max_length=255),
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(None),
):
    await verify_agent_token(db, authorization, hostname)
    sess = await hub.get(session_id)
    if sess is None or not hub.hosts_match(sess.hostname, hostname):
        raise HTTPException(status_code=404, detail="Сессия Assist не найдена")
    ended = await hub.end(session_id)
    return hub.public(ended) if ended else {"id": session_id, "status": "ended"}


@router.post("/sessions/{session_id}/frame")
async def push_frame(
    session_id: str,
    request: Request,
    hostname: str = Query(min_length=1, max_length=255),
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(None),
):
    await verify_agent_token(db, authorization, hostname)
    body = await request.body()
    if len(body) > MAX_FRAME_BYTES:
        raise HTTPException(status_code=413, detail="Кадр слишком большой")
    sess = await hub.get(session_id)
    if sess is None:
        raise HTTPException(status_code=410, detail="Сессия Assist закрыта")
    events = await hub.push_frame(session_id, hostname, body)
    return {"ok": True, "events": events}


@router.websocket("/sessions/{session_id}/live")
async def assist_live(websocket: WebSocket, session_id: str):
    await websocket.accept()
    user = await user_from_access_token(websocket.cookies.get("access_token"))
    if user is None or (not user.is_superuser and (user.role or "") != "editor"):
        await websocket.close(code=4401)
        return
    sess = await hub.attach_admin(session_id, websocket)
    if sess is None:
        await websocket.close(code=4404)
        return
    try:
        await websocket.send_text(json.dumps({"type": "hello", "status": sess.status, "hostname": sess.hostname}))
        while True:
            raw = await websocket.receive_text()
            try:
                packet = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(packet, dict):
                continue
            kind = packet.get("type")
            if kind == "pong":
                continue
            if kind == "input":
                events = packet.get("events")
                if isinstance(events, list):
                    clean = [item for item in events if isinstance(item, dict)]
                    await hub.push_input(session_id, clean[:32])
            elif kind == "end":
                await hub.end(session_id)
                break
    except WebSocketDisconnect:
        pass
    finally:
        await hub.detach_admin(session_id, websocket)
