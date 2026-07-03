from __future__ import annotations

import json
import math
import base64
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape as _xml_escape

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import DatabaseError

from app.auth import _normalized_role, get_current_user, get_current_editor_or_superuser
from app.database import DiagramsSessionLocal, get_diagrams_db
from app.diagram_live import DiagramRoomClient, diagram_live_hub, user_from_access_token
from app.models import Diagram, DiagramBinding, User
from app.svg_export import SvgExportError, svg_export_available, svg_to_pdf, svg_to_png

router = APIRouter(prefix="/diagrams", tags=["diagrams"])

BLANK_FLOOR_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800">
  <rect width="1200" height="800" fill="#f1f5f9"/>
  <text x="600" y="390" text-anchor="middle" fill="#64748b" font-family="system-ui,sans-serif" font-size="18">
    План этажа — нарисуйте кабинеты и расставьте ПК (режим редактирования)
  </text>
</svg>"""


@router.get("/converter-status")
async def converter_status(_: User = Depends(get_current_user)):
    ok, reason = svg_export_available()
    return {"ok": ok, "engine": "cairosvg", "detail": reason}


class DiagramOut(BaseModel):
    id: int
    title: str
    source_filename: str
    created_at: str | None = None
    sort_order: int = 0
    has_visio_source: bool = True


class DiagramPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    sort_order: int | None = Field(default=None, ge=0, le=1_000_000)


class FloorRoomRect(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    x: float
    y: float
    w: float = Field(gt=0, le=1_000_000)
    h: float = Field(gt=0, le=1_000_000)
    label: str = Field(default="", max_length=160)
    fill: str = Field(default="rgba(148,163,184,0.18)", max_length=80)
    stroke: str = Field(default="#64748b", max_length=80)


class FloorComputerMarker(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    computer_id: int = Field(ge=1)
    x: float
    y: float
    label: str | None = Field(default=None, max_length=255)


class FloorIconMarker(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    kind: str = Field(
        pattern="^(pc|server|printer|camera|ap|switch|door|stairs|elevator|text|ethernet_outlet|phone_outlet)$"
    )
    x: float
    y: float
    label: str | None = Field(default=None, max_length=255)
    rotation: float | None = Field(default=None, ge=-3600, le=3600)
    scale: float | None = Field(default=None, ge=0.05, le=50)
    meta: dict[str, str | None] | None = Field(default=None)


class FloorPoint(BaseModel):
    x: float
    y: float


class FloorWallPolyline(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    points: list[FloorPoint] = Field(min_length=2, max_length=400)
    stroke: str = Field(default="#0f172a", max_length=80)
    stroke_width: float = Field(default=6, ge=1, le=80)
    opacity: float = Field(default=0.9, ge=0.05, le=1.0)


class FloorLayoutPayload(BaseModel):
    version: int = 1
    rooms: list[FloorRoomRect] = Field(default_factory=list, max_length=800)
    computers: list[FloorComputerMarker] = Field(default_factory=list, max_length=5000)
    icons: list[FloorIconMarker] = Field(default_factory=list, max_length=5000)
    walls: list[FloorWallPolyline] = Field(default_factory=list, max_length=4000)


class FloorLayoutPatchPayload(BaseModel):
    rooms: list[FloorRoomRect] | None = Field(default=None, max_length=800)
    computers: list[FloorComputerMarker] | None = Field(default=None, max_length=5000)
    icons: list[FloorIconMarker] | None = Field(default=None, max_length=5000)
    walls: list[FloorWallPolyline] | None = Field(default=None, max_length=4000)


class BlankFloorIn(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    sort_order: int | None = Field(default=None, ge=0, le=1_000_000)


class BindingIn(BaseModel):
    shape_id: str = Field(min_length=1, max_length=255)
    object_type: str = Field(pattern="^(tag|user|computer|monitor|request)$")
    object_id: int
    label: str | None = Field(default=None, max_length=255)


class ExportedFloor(BaseModel):
    title: str = Field(default="Этаж", max_length=255)
    sort_order: int = Field(default=0, ge=0, le=1_000_000)
    svg_text: str = Field(default="")
    source_filename: str = Field(default="", max_length=255)
    layout: FloorLayoutPayload = Field(default_factory=FloorLayoutPayload)


class ExportedFloorsBundle(BaseModel):
    version: int = 1
    floors: list[ExportedFloor] = Field(default_factory=list, max_length=2000)


def _diagram_has_visio_source(d: Diagram) -> bool:
    fn = (d.source_filename or "").lower().strip()
    return bool(d.source_bytes and len(d.source_bytes) > 0 and (fn.endswith(".vsdx") or fn.endswith(".vsd")))


def _safe_text(v: str | None, max_len: int = 160) -> str:
    t = (v or "").strip()
    if not t:
        return ""
    if len(t) > max_len:
        t = t[: max_len - 1]
    return _xml_escape(t)


def _split_label_lines(label: str, *, max_lines: int = 2) -> list[str]:
    words = [w for w in label.split(" ") if w]
    if not words:
        return []
    if len(words) == 1:
        return [words[0]]
    if max_lines <= 1:
        return [" ".join(words)]
    cut = (len(words) + 1) // 2
    first = " ".join(words[:cut]).strip()
    second = " ".join(words[cut:]).strip()
    return [line for line in (first, second) if line][:max_lines]


def _svg_text_multiline(x: float, y: float, lines: list[str], *, size: int = 11, weight: int = 600) -> str:
    if not lines:
        return ""
    tspans = "".join(
        f'<tspan x="{x}" dy="{0 if i == 0 else 12}">{line}</tspan>' for i, line in enumerate(lines)
    )
    return (
        f'<text x="{x}" y="{y}" text-anchor="middle" fill="#0f172a" font-size="{size}" '
        f'font-family="system-ui,Segoe UI,Arial" font-weight="{weight}" '
        f'style="paint-order:stroke;stroke:rgba(255,255,255,0.75);stroke-width:2.5px;stroke-linejoin:round">'
        f"{tspans}</text>"
    )


def _png_size(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")


def _png_background_svg(raw: bytes, title: str) -> str:
    size = _png_size(raw)
    if size is None:
        raise HTTPException(status_code=400, detail="Ожидается корректный PNG-файл.")
    w, h = size
    if w <= 0 or h <= 0:
        raise HTTPException(status_code=400, detail="PNG-файл имеет некорректный размер.")
    encoded = base64.b64encode(raw).decode("ascii")
    safe_title = _safe_text(title, 160) or "Карта сайта"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
        f"<title>{safe_title}</title>"
        f'<image href="data:image/png;base64,{encoded}" x="0" y="0" width="{w}" height="{h}" '
        'preserveAspectRatio="xMidYMid meet" />'
        "</svg>"
    )


def _overlay_svg(layout: FloorLayoutPayload, *, include_labels: bool = True) -> str:
    # Draw rooms, PCs, and icons as an overlay group.
    out: list[str] = []
    out.append('<g id="inventory-overlay" data-inventory="1">')

    # Walls (under rooms/markers)
    for w in layout.walls:
        pts = w.points or []
        if len(pts) < 2:
            continue
        d = "M " + " L ".join(f"{p.x} {p.y}" for p in pts)
        stroke = _xml_escape(w.stroke or "#0f172a")
        sw = float(w.stroke_width or 6)
        op = float(w.opacity or 0.9)
        out.append(
            f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{sw}" opacity="{op}" '
            f'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />'
        )

    # Rooms
    for r in layout.rooms:
        lab = _safe_text(r.label, 120)
        out.append(
            f'<rect x="{r.x}" y="{r.y}" width="{r.w}" height="{r.h}" fill="{_xml_escape(r.fill)}" '
            f'stroke="{_xml_escape(r.stroke)}" stroke-width="1.5" vector-effect="non-scaling-stroke" />'
        )
        if lab and include_labels:
            out.append(
                f'<text x="{r.x + r.w / 2}" y="{r.y + r.h / 2}" text-anchor="middle" dominant-baseline="middle" '
                f'fill="#0f172a" font-size="14" font-family="system-ui,Segoe UI,Arial" font-weight="600" '
                f'style="paint-order:stroke;stroke:rgba(255,255,255,0.75);stroke-width:2.5px;stroke-linejoin:round">'
                f"{lab}</text>"
            )

    # PCs
    for m in layout.computers:
        label = _safe_text(m.label, 80) or _safe_text(f"#{m.computer_id}", 80)
        out.append(f'<g transform="translate({m.x} {m.y})">')
        out.append(
            '<circle cx="0" cy="0" r="22" fill="rgba(37,99,235,0.92)" stroke="#1e3a8a" '
            'stroke-width="1.5" vector-effect="non-scaling-stroke" />'
        )
        # Simple PC pictogram (white).
        out.append('<rect x="-13" y="-10" width="26" height="16" rx="2.5" fill="rgba(255,255,255,0.92)" />')
        out.append('<rect x="-6" y="8" width="12" height="3" rx="1.5" fill="rgba(255,255,255,0.85)" />')
        out.append('<rect x="-10" y="11.5" width="20" height="3" rx="1.5" fill="rgba(255,255,255,0.7)" />')
        out.append("</g>")
        if include_labels:
            out.append(_svg_text_multiline(m.x, m.y + 34, _split_label_lines(label), size=11, weight=600))

    # Icons
    for ic in layout.icons:
        label = _safe_text(ic.label, 80)
        rot = float(ic.rotation or 0)
        scale = float(ic.scale or 1.0)
        if scale <= 0:
            scale = 1.0
        tx = f'translate({ic.x} {ic.y}) rotate({rot}) scale({scale})'
        # "text" is a pure label without a circle.
        if ic.kind == "text":
            if label and include_labels:
                out.append(_svg_text_multiline(ic.x, ic.y, _split_label_lines(label), size=14, weight=700))
            continue
        out.append(f'<g transform="{tx}">')
        if ic.kind == "ethernet_outlet":
            fill = "rgba(16,185,129,0.92)"
            r = 11
        elif ic.kind == "phone_outlet":
            fill = "rgba(245,158,11,0.92)"
            r = 11
        else:
            fill = "rgba(15,23,42,0.85)"
            r = 20
        out.append(
            f'<circle cx="0" cy="0" r="{r}" fill="{fill}" stroke="#0f172a" '
            'stroke-width="1.5" vector-effect="non-scaling-stroke" />'
        )
        # Minimal pictograms (white).
        if ic.kind == "printer":
            out.append('<rect x="-18" y="-6" width="36" height="22" rx="4" fill="rgba(255,255,255,0.92)" />')
            out.append('<rect x="-12" y="-20" width="24" height="14" rx="3" fill="rgba(255,255,255,0.65)" />')
        elif ic.kind == "camera":
            out.append('<rect x="-18" y="-10" width="36" height="20" rx="5" fill="rgba(255,255,255,0.9)" />')
            out.append('<circle cx="0" cy="0" r="8" fill="rgba(15,23,42,0.65)" />')
            out.append('<circle cx="0" cy="0" r="4.5" fill="rgba(255,255,255,0.7)" />')
        elif ic.kind == "ap":
            out.append('<circle cx="0" cy="0" r="4" fill="rgba(255,255,255,0.92)" />')
            out.append('<path d="M -16 3 Q 0 -16 16 3" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="2" stroke-linecap="round" />')
            out.append('<path d="M -12 8 Q 0 -8 12 8" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="2" stroke-linecap="round" opacity="0.9" />')
        elif ic.kind == "pc":
            out.append('<rect x="-13" y="-10" width="26" height="16" rx="2.5" fill="rgba(255,255,255,0.92)" />')
            out.append('<rect x="-6" y="8" width="12" height="3" rx="1.5" fill="rgba(255,255,255,0.85)" />')
            out.append('<rect x="-10" y="11.5" width="20" height="3" rx="1.5" fill="rgba(255,255,255,0.7)" />')
        elif ic.kind == "server":
            out.append('<rect x="-12" y="-16" width="24" height="32" rx="3" fill="rgba(255,255,255,0.92)" />')
            out.append('<rect x="-7" y="-10" width="14" height="3" rx="1.5" fill="rgba(15,23,42,0.45)" />')
            out.append('<rect x="-7" y="-2" width="14" height="3" rx="1.5" fill="rgba(15,23,42,0.45)" />')
            out.append('<circle cx="7" cy="9" r="2" fill="rgba(34,197,94,0.9)" />')
        elif ic.kind == "ethernet_outlet":
            out.append('<rect x="-6.5" y="-4.9" width="13" height="10" rx="1.8" fill="rgba(255,255,255,0.95)" />')
            out.append('<rect x="-3.9" y="-1.8" width="7.8" height="3.5" rx="0.7" fill="rgba(15,23,42,0.35)" />')
            out.append('<rect x="-2.1" y="-3.5" width="4.2" height="1.5" rx="0.4" fill="rgba(15,23,42,0.25)" />')
        elif ic.kind == "phone_outlet":
            out.append('<rect x="-5.6" y="-6.3" width="11.2" height="12.6" rx="2.1" fill="rgba(255,255,255,0.95)" />')
            out.append('<circle cx="0" cy="0" r="2.2" fill="rgba(15,23,42,0.35)" />')
            out.append('<rect x="-0.85" y="-3.9" width="1.7" height="2.5" rx="0.4" fill="rgba(255,255,255,0.9)" />')
        elif ic.kind == "door":
            out.append('<rect x="-14" y="-16" width="28" height="32" rx="2.5" fill="rgba(255,255,255,0.92)" />')
            out.append('<circle cx="7.5" cy="2" r="2.2" fill="rgba(15,23,42,0.55)" />')
        elif ic.kind == "stairs":
            out.append('<path d="M -14 12 H -4 V 6 H 4 V 0 H 12 V -6" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />')
        elif ic.kind == "elevator":
            out.append('<rect x="-13" y="-16" width="26" height="32" rx="3" fill="rgba(255,255,255,0.92)" />')
            out.append('<path d="M 0 -9 L -4 -3 H 4 Z" fill="rgba(15,23,42,0.45)" />')
            out.append('<path d="M 0 9 L 4 3 H -4 Z" fill="rgba(15,23,42,0.45)" />')
        else:  # switch
            out.append('<rect x="-18" y="-11" width="36" height="22" rx="5" fill="rgba(255,255,255,0.92)" />')
            out.append('<rect x="-11" y="-3" width="22" height="6" rx="3" fill="rgba(15,23,42,0.35)" />')
        out.append("</g>")
        if label and include_labels:
            out.append(_svg_text_multiline(ic.x, ic.y + 34, _split_label_lines(label), size=11, weight=600))

    out.append("</g>")
    return "".join(out)


def _merge_svg_with_overlay(svg_text: str, layout: FloorLayoutPayload, *, include_labels: bool = True) -> str:
    base = (svg_text or "").strip()
    if not base:
        base = BLANK_FLOOR_SVG.strip()
    overlay = _overlay_svg(layout, include_labels=include_labels)
    # Insert overlay before closing </svg>
    idx = base.lower().rfind("</svg>")
    if idx >= 0:
        return base[:idx] + overlay + base[idx:]
    # Fallback: wrap as a valid svg
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">{base}{overlay}</svg>'


@router.get("")
async def list_diagrams(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_diagrams_db)):
    try:
        r = await db.execute(select(Diagram).order_by(Diagram.sort_order.asc(), Diagram.id.asc()).limit(200))
        rows = r.scalars().all()
    except DatabaseError:
        raise HTTPException(
            status_code=500,
            detail="База схем (diagrams) недоступна или повреждена. Проверьте PostgreSQL и восстановите из резервной копии.",
        )
    return [
        {
            "id": d.id,
            "title": d.title,
            "source_filename": d.source_filename,
            "created_at": d.created_at.isoformat().replace("+00:00", "Z") if d.created_at else None,
            "sort_order": int(getattr(d, "sort_order", 0) or 0),
            "has_visio_source": _diagram_has_visio_source(d),
        }
        for d in rows
    ]


@router.post("/floor-blank", response_model=DiagramOut)
async def create_blank_floor(
    body: BlankFloorIn,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_diagrams_db),
):
    max_sort = await db.scalar(select(func.coalesce(func.max(Diagram.sort_order), 0)))
    next_sort = int(max_sort or 0) + 1
    sort_order = int(body.sort_order) if body.sort_order is not None else next_sort
    title = (body.title or f"Этаж {sort_order}").strip()[:255] or f"Этаж {sort_order}"
    d = Diagram(
        title=title,
        source_filename="",
        source_mime="",
        source_bytes=b"",
        svg_text=BLANK_FLOOR_SVG,
        sort_order=sort_order,
        floor_layout_json="{}",
    )
    db.add(d)
    await db.commit()
    await db.refresh(d)
    return DiagramOut(
        id=d.id,
        title=d.title,
        source_filename=d.source_filename,
        created_at=d.created_at.isoformat().replace("+00:00", "Z") if d.created_at else None,
        sort_order=int(d.sort_order or 0),
        has_visio_source=_diagram_has_visio_source(d),
    )


@router.post("/import-background-png", response_model=DiagramOut)
async def import_background_png(
    file: UploadFile = File(...),
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_diagrams_db),
):
    fn = (file.filename or "").strip()
    if not fn:
        raise HTTPException(status_code=400, detail="Файл не выбран.")
    if not fn.lower().endswith(".png"):
        raise HTTPException(status_code=400, detail="Ожидается PNG-файл.")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл.")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PNG-файл слишком большой. Максимум 15 МБ.")

    title = Path(fn).stem[:255] or "Карта сайта"
    svg_text = _png_background_svg(raw, title)
    max_sort = await db.scalar(select(func.coalesce(func.max(Diagram.sort_order), 0)))
    sort_order = int(max_sort or 0) + 1
    d = Diagram(
        title=title,
        source_filename=fn[:255],
        source_mime="image/png",
        source_bytes=raw,
        svg_text=svg_text,
        sort_order=sort_order,
        floor_layout_json="{}",
    )
    db.add(d)
    await db.commit()
    await db.refresh(d)
    return DiagramOut(
        id=d.id,
        title=d.title,
        source_filename=d.source_filename,
        created_at=d.created_at.isoformat().replace("+00:00", "Z") if d.created_at else None,
        sort_order=int(d.sort_order or 0),
        has_visio_source=_diagram_has_visio_source(d),
    )


@router.put("/{diagram_id}/background-png", response_model=DiagramOut)
async def replace_background_png(
    diagram_id: int,
    file: UploadFile = File(...),
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_diagrams_db),
):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    fn = (file.filename or "").strip()
    if not fn:
        raise HTTPException(status_code=400, detail="Файл не выбран.")
    if not fn.lower().endswith(".png"):
        raise HTTPException(status_code=400, detail="Ожидается PNG-файл.")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл.")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PNG-файл слишком большой. Максимум 15 МБ.")
    d.source_filename = fn[:255]
    d.source_mime = "image/png"
    d.source_bytes = raw
    d.svg_text = _png_background_svg(raw, d.title or "Карта сайта")
    await db.commit()
    await db.refresh(d)
    return DiagramOut(
        id=d.id,
        title=d.title,
        source_filename=d.source_filename,
        created_at=d.created_at.isoformat().replace("+00:00", "Z") if d.created_at else None,
        sort_order=int(d.sort_order or 0),
        has_visio_source=_diagram_has_visio_source(d),
    )


@router.get("/{diagram_id}/layout", response_model=FloorLayoutPayload)
async def get_floor_layout(diagram_id: int, _: User = Depends(get_current_user), db: AsyncSession = Depends(get_diagrams_db)):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    raw = (getattr(d, "floor_layout_json", None) or "").strip() or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}
    try:
        return FloorLayoutPayload.model_validate(data)
    except Exception:
        return FloorLayoutPayload()


@router.put("/{diagram_id}/layout")
async def put_floor_layout(
    diagram_id: int,
    body: FloorLayoutPayload,
    editor: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_diagrams_db),
):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    d.floor_layout_json = body.model_dump_json()
    await db.commit()
    disp = (editor.full_name or "").strip() or editor.username
    await diagram_live_hub.broadcast_layout_changed(diagram_id, editor.username, disp)
    return {"ok": True}


@router.patch("/{diagram_id}/layout")
async def patch_floor_layout(
    diagram_id: int,
    body: FloorLayoutPatchPayload,
    editor: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_diagrams_db),
):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    raw = (getattr(d, "floor_layout_json", None) or "").strip() or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}
    floor = FloorLayoutPayload.model_validate(data)
    if body.rooms is not None:
        floor.rooms = body.rooms
    if body.computers is not None:
        floor.computers = body.computers
    if body.icons is not None:
        floor.icons = body.icons
    if body.walls is not None:
        floor.walls = body.walls
    d.floor_layout_json = floor.model_dump_json()
    await db.commit()
    disp = (editor.full_name or "").strip() or editor.username
    await diagram_live_hub.broadcast_layout_changed(diagram_id, editor.username, disp)
    return {"ok": True}


@router.patch("/{diagram_id}", response_model=DiagramOut)
async def patch_diagram(
    diagram_id: int,
    body: DiagramPatch,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_diagrams_db),
):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    if body.title is not None:
        d.title = body.title.strip()[:255]
    if body.sort_order is not None:
        d.sort_order = int(body.sort_order)
    await db.commit()
    await db.refresh(d)
    return DiagramOut(
        id=d.id,
        title=d.title,
        source_filename=d.source_filename,
        created_at=d.created_at.isoformat().replace("+00:00", "Z") if d.created_at else None,
        sort_order=int(d.sort_order or 0),
        has_visio_source=_diagram_has_visio_source(d),
    )


@router.post("/import-visio")
async def import_visio(
    _: User = Depends(get_current_editor_or_superuser),
):
    raise HTTPException(
        status_code=410,
        detail="Импорт Visio отключён. Загрузите PNG (import-background-png) или создайте пустой этаж (floor-blank).",
    )


@router.get("/{diagram_id}/svg")
async def get_svg(diagram_id: int, _: User = Depends(get_current_user), db: AsyncSession = Depends(get_diagrams_db)):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    if not (d.svg_text or "").strip():
        raise HTTPException(status_code=404, detail="SVG не найден для этой схемы")
    return Response(content=d.svg_text, media_type="image/svg+xml; charset=utf-8")


@router.get("/{diagram_id}/export.json")
async def export_layout_json(diagram_id: int, _: User = Depends(get_current_user), db: AsyncSession = Depends(get_diagrams_db)):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    raw = (getattr(d, "floor_layout_json", None) or "").strip() or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}
    layout = FloorLayoutPayload.model_validate(data)
    # Extract viewBox if present (best-effort).
    vb = None
    svg = (d.svg_text or "").strip()
    if "viewBox" in svg or "viewbox" in svg:
        import re

        m = re.search(r'viewBox\s*=\s*"([^"]+)"', svg, flags=re.IGNORECASE)
        if m:
            vb = m.group(1).strip()[:80]
    return {
        "diagram_id": d.id,
        "title": d.title,
        "viewBox": vb,
        "layout": layout.model_dump(),
    }


@router.get("/export-floors.json")
async def export_floors_bundle(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_diagrams_db)):
    r = await db.execute(select(Diagram).order_by(Diagram.sort_order.asc(), Diagram.id.asc()).limit(2000))
    rows = r.scalars().all()
    floors: list[ExportedFloor] = []
    for d in rows:
        raw = (getattr(d, "floor_layout_json", None) or "").strip() or "{}"
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {}
        try:
            layout = FloorLayoutPayload.model_validate(data)
        except Exception:
            layout = FloorLayoutPayload()
        floors.append(
            ExportedFloor(
                title=(d.title or "Этаж")[:255],
                sort_order=int(getattr(d, "sort_order", 0) or 0),
                svg_text=(d.svg_text or ""),
                source_filename=(d.source_filename or "")[:255],
                layout=layout,
            )
        )
    return ExportedFloorsBundle(version=1, floors=floors).model_dump()


@router.post("/import-floors-json")
async def import_floors_bundle(
    file: UploadFile = File(...),
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_diagrams_db),
):
    fn = (file.filename or "").strip() or "floors.json"
    if not fn.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Ожидается JSON-файл.")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл.")
    try:
        parsed = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        raise HTTPException(status_code=400, detail="Не удалось прочитать JSON.")
    try:
        bundle = ExportedFloorsBundle.model_validate(parsed)
    except Exception:
        raise HTTPException(status_code=400, detail="Неверный формат экспорта этажей.")

    created = 0
    max_sort = await db.scalar(select(func.coalesce(func.max(Diagram.sort_order), 0)))
    next_sort = int(max_sort or 0) + 1

    for f in bundle.floors:
        sort_order = int(f.sort_order or 0)
        if sort_order <= 0:
            sort_order = next_sort
            next_sort += 1
        title = (f.title or f"Этаж {sort_order}").strip()[:255] or f"Этаж {sort_order}"
        svg_text = (f.svg_text or "").strip() or BLANK_FLOOR_SVG
        d = Diagram(
            title=title,
            source_filename=(f.source_filename or "")[:255],
            source_mime="application/json",
            source_bytes=b"",
            svg_text=svg_text,
            sort_order=sort_order,
            floor_layout_json=f.layout.model_dump_json(),
        )
        db.add(d)
        created += 1

    await db.commit()
    return {"ok": True, "created": created}

@router.get("/{diagram_id}/export.svg")
async def export_merged_svg(
    diagram_id: int,
    include_labels: bool = Query(True),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_diagrams_db),
):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    raw = (getattr(d, "floor_layout_json", None) or "").strip() or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}
    layout = FloorLayoutPayload.model_validate(data)
    merged = _merge_svg_with_overlay(d.svg_text or "", layout, include_labels=bool(include_labels))
    headers = {"Content-Disposition": f'attachment; filename="building-map-{diagram_id}.svg"'}
    return Response(content=merged, media_type="image/svg+xml; charset=utf-8", headers=headers)


@router.get("/{diagram_id}/export.png")
async def export_merged_png(
    diagram_id: int,
    include_labels: bool = Query(True),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_diagrams_db),
):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    raw = (getattr(d, "floor_layout_json", None) or "").strip() or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}
    layout = FloorLayoutPayload.model_validate(data)
    merged = _merge_svg_with_overlay(d.svg_text or "", layout, include_labels=bool(include_labels))
    try:
        payload = svg_to_png(merged)
    except SvgExportError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    headers = {"Content-Disposition": f'attachment; filename="building-map-{diagram_id}.png"'}
    return Response(content=payload, media_type="image/png", headers=headers)


@router.get("/{diagram_id}/export.pdf")
async def export_merged_pdf(
    diagram_id: int,
    include_labels: bool = Query(True),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_diagrams_db),
):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    raw = (getattr(d, "floor_layout_json", None) or "").strip() or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = {}
    layout = FloorLayoutPayload.model_validate(data)
    merged = _merge_svg_with_overlay(d.svg_text or "", layout, include_labels=bool(include_labels))
    try:
        payload = svg_to_pdf(merged)
    except SvgExportError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    headers = {"Content-Disposition": f'attachment; filename="building-map-{diagram_id}.pdf"'}
    return Response(content=payload, media_type="application/pdf", headers=headers)


@router.get("/{diagram_id}/png")
async def get_png(diagram_id: int, _: User = Depends(get_current_user), db: AsyncSession = Depends(get_diagrams_db)):
    """PNG из сохранённого SVG этажа (cairosvg)."""
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    svg = (d.svg_text or "").strip()
    if not svg:
        raise HTTPException(status_code=400, detail="Для этажа нет SVG. Загрузите PNG или создайте план.")
    try:
        payload = svg_to_png(svg)
    except SvgExportError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    headers = {"Content-Disposition": f'attachment; filename="diagram-{diagram_id}.png"'}
    return Response(content=payload, media_type="image/png", headers=headers)


@router.get("/{diagram_id}/bindings")
async def get_bindings(diagram_id: int, _: User = Depends(get_current_user), db: AsyncSession = Depends(get_diagrams_db)):
    r = await db.execute(
        select(DiagramBinding).where(DiagramBinding.diagram_id == diagram_id).order_by(DiagramBinding.id.asc())
    )
    rows = r.scalars().all()
    return [
        {
            "id": b.id,
            "shape_id": b.shape_id,
            "object_type": b.object_type,
            "object_id": b.object_id,
            "label": b.label,
        }
        for b in rows
    ]


@router.put("/{diagram_id}/bindings")
async def replace_bindings(
    diagram_id: int,
    body: list[BindingIn],
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_diagrams_db),
):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")

    await db.execute(delete(DiagramBinding).where(DiagramBinding.diagram_id == diagram_id))
    for b in body:
        db.add(
            DiagramBinding(
                diagram_id=diagram_id,
                shape_id=b.shape_id.strip()[:255],
                object_type=b.object_type,
                object_id=int(b.object_id),
                label=(b.label.strip()[:255] if isinstance(b.label, str) and b.label.strip() else None),
            )
        )
    await db.commit()
    return {"ok": True, "count": len(body)}


@router.delete("/{diagram_id}")
async def delete_diagram(diagram_id: int, _: User = Depends(get_current_editor_or_superuser), db: AsyncSession = Depends(get_diagrams_db)):
    d = await db.get(Diagram, diagram_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Схема не найдена")
    await db.execute(delete(DiagramBinding).where(DiagramBinding.diagram_id == diagram_id))
    await db.execute(delete(Diagram).where(Diagram.id == diagram_id))
    await db.commit()
    return {"ok": True}


@router.websocket("/{diagram_id}/live")
async def diagram_live_websocket(websocket: WebSocket, diagram_id: int):
    await websocket.accept()
    user = await user_from_access_token(websocket.cookies.get("access_token"))
    if user is None:
        await websocket.close(code=4401)
        return
    async with DiagramsSessionLocal() as ddb:
        d = await ddb.get(Diagram, diagram_id)
    if d is None:
        await websocket.close(code=4404)
        return
    display = (user.full_name or "").strip() or user.username
    client = DiagramRoomClient(ws=websocket, user_id=user.id, username=user.username, display_name=display)
    await diagram_live_hub.register(diagram_id, client)
    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            t = msg.get("type")
            if t == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}, ensure_ascii=False))
            elif t == "icon_drag":
                if not user.is_superuser and _normalized_role(user) != "editor":
                    continue
                icons_raw = msg.get("icons")
                if not isinstance(icons_raw, list):
                    continue
                safe: list[dict] = []
                for it in icons_raw[:120]:
                    if not isinstance(it, dict):
                        continue
                    iid = it.get("id")
                    if not isinstance(iid, str) or not iid.strip():
                        continue
                    try:
                        x = float(it.get("x"))
                        y = float(it.get("y"))
                    except (TypeError, ValueError):
                        continue
                    if not (math.isfinite(x) and math.isfinite(y)):
                        continue
                    safe.append({"id": iid.strip()[:256], "x": x, "y": y})
                if safe:
                    await diagram_live_hub.relay_icon_drag(diagram_id, client, safe)
            elif t == "activity":
                kind = msg.get("kind")
                if isinstance(kind, str):
                    await diagram_live_hub.broadcast_peer_activity(diagram_id, client, kind)
    finally:
        await diagram_live_hub.unregister(diagram_id, client)

