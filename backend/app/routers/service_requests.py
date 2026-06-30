from io import BytesIO
import csv
from datetime import datetime
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from fpdf import FPDF

from app.auth import get_current_user, get_current_editor_or_superuser
from app.database import get_db
from app.models import (
    Computer,
    ServiceRequest,
    ServiceRequestTemplate,
    User,
    service_request_assignees,
    service_request_template_assignees,
)
from app.schemas import (
    ServiceRequestCreate,
    ServiceRequestListResponse,
    ServiceRequestOut,
    ServiceRequestPatch,
    ServiceRequestTemplateCreate,
    ServiceRequestTemplateListResponse,
    ServiceRequestTemplateOut,
    ServiceRequestTemplatePatch,
)
from app.service_request_tickets import ensure_ticket_no, is_service_request_closed, stamp_closed_at_if_needed

router = APIRouter(prefix="/service-requests", tags=["service-requests"])

_GLPI_HEADERS = [
    "ID",
    "Заголовок",
    "Местоположение",
    "Статус",
    "Последнее изменение",
    "Инициатор запроса - Инициатор запроса",
    "Дата открытия",
    "Приоритет",
    "Категория",
]

_GLPI_REQUIRED_HEADERS = [
    "ID",
    "Заголовок",
    "Статус",
    "Последнее изменение",
    "Инициатор запроса - Инициатор запроса",
    "Дата открытия",
    "Приоритет",
    "Категория",
]

_GLPI_DT_FMT = "%d-%m-%Y %H:%M"
_BR_RE = re.compile(r"\s*<br\s*/?>\s*", re.IGNORECASE)


def _parse_glpi_dt(s: str | None) -> datetime | None:
    t = (s or "").strip()
    if not t:
        return None
    try:
        return datetime.strptime(t, _GLPI_DT_FMT)
    except Exception:
        return None


def _norm_requester(s: str | None) -> str | None:
    t = (s or "").strip()
    if not t:
        return None
    t = _BR_RE.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t or None


def _map_priority_to_internal(glpi_priority: str | None) -> str:
    p = (glpi_priority or "").strip().lower()
    if p in ("низкий", "low"):
        return "low"
    if p in ("высокий", "high"):
        return "high"
    return "normal"


def _map_status_to_internal(glpi_status: str | None) -> str:
    s = (glpi_status or "").strip().lower()
    if s in ("закрыто", "закрыта", "closed", "done"):
        return "done"
    if s in ("в работе", "выполняется", "in progress", "in_progress"):
        return "in_progress"
    return "open"


async def _to_out(db: AsyncSession, row: ServiceRequest) -> ServiceRequestOut:
    created_by = await db.get(User, row.created_by_id)
    computer = await db.get(Computer, row.computer_id) if row.computer_id else None
    ar = await db.execute(
        select(User.id, User.username)
        .join(service_request_assignees, service_request_assignees.c.user_id == User.id)
        .where(service_request_assignees.c.request_id == row.id)
        .order_by(User.username.asc())
    )
    assignee_rows = ar.all()
    return ServiceRequestOut(
        id=row.id,
        ticket_no=row.ticket_no,
        glpi_id=row.glpi_id,
        title=row.title,
        description=row.description,
        status=row.status,
        priority=row.priority,
        glpi_status=row.glpi_status,
        glpi_priority=row.glpi_priority,
        glpi_updated_at=row.glpi_updated_at,
        external_source=getattr(row, "external_source", None),
        external_id=getattr(row, "external_id", None),
        external_url=getattr(row, "external_url", None),
        requester_name=row.requester_name,
        category=row.category,
        location=row.location,
        created_by_id=row.created_by_id,
        created_by_username=(created_by.username if created_by else "unknown"),
        assignee_ids=[int(x[0]) for x in assignee_rows],
        assignee_usernames=[str(x[1]) for x in assignee_rows],
        computer_id=row.computer_id,
        computer_hostname=(computer.hostname if computer else None),
        created_at=row.created_at,
        updated_at=row.updated_at,
        opened_at=row.opened_at,
        planned_close_at=row.planned_close_at,
        closed_at=row.closed_at,
    )


async def _template_to_out(db: AsyncSession, row: ServiceRequestTemplate) -> ServiceRequestTemplateOut:
    created_by = await db.get(User, row.created_by_id)
    ar = await db.execute(
        select(User.id, User.username)
        .join(service_request_template_assignees, service_request_template_assignees.c.user_id == User.id)
        .where(service_request_template_assignees.c.template_id == row.id)
        .order_by(User.username.asc())
    )
    assignee_rows = ar.all()
    return ServiceRequestTemplateOut(
        id=row.id,
        title=row.title,
        description=row.description,
        status=row.status,
        priority=row.priority,
        requester_name=row.requester_name,
        category=row.category,
        computer_id=row.computer_id,
        assignee_ids=[int(x[0]) for x in assignee_rows],
        assignee_usernames=[str(x[1]) for x in assignee_rows],
        opened_at=row.opened_at,
        planned_close_at=row.planned_close_at,
        closed_at=row.closed_at,
        created_by_id=row.created_by_id,
        created_by_username=(created_by.username if created_by else "unknown"),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("", response_model=ServiceRequestListResponse)
async def list_service_requests(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    status: str | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
):
    last_change = func.coalesce(ServiceRequest.glpi_updated_at, ServiceRequest.updated_at)
    stmt = select(ServiceRequest).order_by(last_change.desc(), ServiceRequest.id.desc())
    if status:
        stmt = stmt.where(ServiceRequest.status == status)
    stmt = stmt.limit(limit)
    r = await db.execute(stmt)
    rows = r.scalars().all()
    out = [await _to_out(db, x) for x in rows]
    total_stmt = select(func.count()).select_from(ServiceRequest)
    if status:
        total_stmt = total_stmt.where(ServiceRequest.status == status)
    total = int(await db.scalar(total_stmt) or 0)
    return ServiceRequestListResponse(items=out, total=total)


@router.post("", response_model=ServiceRequestOut)
async def create_service_request(
    body: ServiceRequestCreate,
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = ServiceRequest(
        title=body.title.strip(),
        description=body.description,
        status=body.status,
        priority=body.priority,
        requester_name=(body.requester_name.strip() if body.requester_name else None),
        category=(body.category.strip() if body.category else None),
        location=(body.location.strip() if body.location else None),
        created_by_id=current.id,
        computer_id=body.computer_id,
        opened_at=body.opened_at,
        planned_close_at=body.planned_close_at,
        closed_at=body.closed_at,
    )
    db.add(row)
    await db.flush()
    stamp_closed_at_if_needed(row, was_closed=False)
    await ensure_ticket_no(db, row)
    for uid in body.assignee_ids:
        await db.execute(service_request_assignees.insert().values(request_id=row.id, user_id=uid))
    await db.commit()
    await db.refresh(row)
    return await _to_out(db, row)


@router.patch("/{request_id}", response_model=ServiceRequestOut)
async def patch_service_request(
    request_id: int,
    body: ServiceRequestPatch,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(ServiceRequest, request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Заявка не найдена")
    was_closed = is_service_request_closed(row)
    patch = body.model_dump(exclude_unset=True)
    for k in [
        "title",
        "description",
        "status",
        "priority",
        "requester_name",
        "category",
        "location",
        "computer_id",
        "opened_at",
        "planned_close_at",
        "closed_at",
    ]:
        if k in patch:
            setattr(row, k, patch[k])
    if "assignee_ids" in patch:
        await db.execute(delete(service_request_assignees).where(service_request_assignees.c.request_id == request_id))
        for uid in patch["assignee_ids"] or []:
            await db.execute(service_request_assignees.insert().values(request_id=request_id, user_id=uid))
    stamp_closed_at_if_needed(row, was_closed=was_closed)
    await ensure_ticket_no(db, row)
    await db.commit()
    await db.refresh(row)
    return await _to_out(db, row)


@router.post("/{request_id}/delete")
async def delete_service_request(
    request_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(ServiceRequest, request_id)
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True}


@router.post("/delete-all")
async def delete_all_service_requests(
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    if not current.is_superuser:
        raise HTTPException(status_code=403, detail="Только администратор может удалять все заявки")

    deleted = int(await db.scalar(select(func.count()).select_from(ServiceRequest)) or 0)
    if deleted == 0:
        return {"ok": True, "deleted": 0}

    await db.execute(delete(service_request_assignees))
    await db.execute(delete(ServiceRequest))
    await db.commit()
    return {"ok": True, "deleted": deleted}


@router.post("/import-glpi-csv")
async def import_glpi_csv(
    file: UploadFile = File(...),
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    raw = await file.read()
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    if text is None:
        raise HTTPException(status_code=400, detail="Не удалось прочитать CSV (кодировка)")

    reader = csv.DictReader(text.splitlines(), delimiter=";", quotechar='"')
    headers = reader.fieldnames or []
    missing = [h for h in _GLPI_REQUIRED_HEADERS if h and h not in headers]
    if missing:
        raise HTTPException(status_code=400, detail=f"CSV не похож на GLPI: нет колонок: {', '.join(missing)}")

    created = 0
    updated = 0
    skipped = 0
    errors: list[str] = []

    for idx, row in enumerate(reader, start=2):
        try:
            gid_raw = (row.get("ID") or "").strip().strip('"')
            if not gid_raw:
                skipped += 1
                continue
            gid = int(gid_raw)
            title = (row.get("Заголовок") or "").strip()
            if not title:
                skipped += 1
                continue

            glpi_status = (row.get("Статус") or "").strip() or None
            glpi_priority = (row.get("Приоритет") or "").strip() or None
            glpi_updated_at = _parse_glpi_dt(row.get("Последнее изменение"))
            opened_at = _parse_glpi_dt(row.get("Дата открытия"))
            requester_name = _norm_requester(row.get("Инициатор запроса - Инициатор запроса"))
            category = (row.get("Категория") or "").strip() or None
            location = (row.get("Местоположение") or "").strip() or None

            existing = await db.scalar(select(ServiceRequest).where(ServiceRequest.glpi_id == gid))
            if existing:
                was_closed = is_service_request_closed(existing)
                existing.title = title
                existing.glpi_id = gid
                existing.glpi_status = glpi_status
                existing.glpi_priority = glpi_priority
                existing.glpi_updated_at = glpi_updated_at
                existing.requester_name = requester_name
                existing.category = category
                existing.location = location or existing.location
                existing.opened_at = opened_at or existing.opened_at
                existing.status = _map_status_to_internal(glpi_status) if glpi_status else existing.status
                existing.priority = _map_priority_to_internal(glpi_priority) if glpi_priority else existing.priority
                stamp_closed_at_if_needed(existing, was_closed=was_closed)
                await ensure_ticket_no(db, existing)
                updated += 1
            else:
                row_db = ServiceRequest(
                    glpi_id=gid,
                    title=title,
                    status=_map_status_to_internal(glpi_status),
                    priority=_map_priority_to_internal(glpi_priority),
                    glpi_status=glpi_status,
                    glpi_priority=glpi_priority,
                    glpi_updated_at=glpi_updated_at,
                    requester_name=requester_name,
                    category=category,
                    location=location,
                    created_by_id=current.id,
                    opened_at=opened_at,
                )
                db.add(row_db)
                await db.flush()
                stamp_closed_at_if_needed(row_db, was_closed=False)
                await ensure_ticket_no(db, row_db)
                created += 1
        except Exception as e:
            errors.append(f"строка {idx}: {e}")

    await db.commit()
    return {"ok": True, "created": created, "updated": updated, "skipped": skipped, "errors": errors[:50]}


@router.get("/export-glpi-csv")
async def export_glpi_csv(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    status: str | None = Query(None),
    limit: int = Query(2000, ge=1, le=20000),
):
    stmt = select(ServiceRequest).order_by(ServiceRequest.glpi_id.desc().nullslast(), ServiceRequest.id.desc()).limit(limit)
    if status:
        stmt = stmt.where(ServiceRequest.status == status)
    r = await db.execute(stmt)
    rows = r.scalars().all()

    def q(v: str) -> str:
        return '"' + v.replace('"', '""') + '"'

    # GLPI export ends lines with a trailing ';' (empty last column)
    out_lines = [";".join(q(h) for h in _GLPI_HEADERS) + ";"]
    for t in rows:
        glpi_id = str(t.glpi_id) if t.glpi_id is not None else str(t.id)
        last_change = (t.glpi_updated_at or t.updated_at)
        opened = t.opened_at
        out_lines.append(
            ";".join(
                [
                    q(glpi_id),
                    q(t.title or ""),
                    q(t.location or ""),
                    q(t.glpi_status or t.status or ""),
                    q(last_change.strftime(_GLPI_DT_FMT) if last_change else ""),
                    q(t.requester_name or ""),
                    q(opened.strftime(_GLPI_DT_FMT) if opened else ""),
                    q(t.glpi_priority or ""),
                    q(t.category or ""),
                ]
            )
            + ";"
        )

    data = BytesIO(("\r\n".join(out_lines) + "\r\n").encode("utf-8"))
    return StreamingResponse(
        data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=glpi.csv"},
    )


@router.get("/export-pdf")
async def export_pdf(
    _: User = Depends(get_current_user),
    status: str | None = Query(None),
    limit: int = Query(400, ge=1, le=4000),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ServiceRequest)
    if status:
        stmt = stmt.where(ServiceRequest.status == status)
    last_change = func.coalesce(ServiceRequest.glpi_updated_at, ServiceRequest.updated_at)
    stmt = stmt.order_by(last_change.desc(), ServiceRequest.id.desc()).limit(limit)
    r = await db.execute(stmt)
    rows = r.scalars().all()

    def _dt(v: datetime | None) -> str:
        if not v:
            return ""
        try:
            return v.strftime(_GLPI_DT_FMT)
        except Exception:
            return ""

    pdf = FPDF(orientation="L", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=10)
    pdf.add_page()

    # Use Unicode font on Windows to support Cyrillic.
    font_loaded = False
    for p in [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("C:/Windows/Fonts/tahoma.ttf"),
        Path("C:/Windows/Fonts/calibri.ttf"),
    ]:
        if p.is_file():
            try:
                pdf.add_font("UI", "", str(p), uni=True)
                pdf.add_font("UI", "B", str(p), uni=True)
                pdf.set_font("UI", style="B", size=14)
                font_loaded = True
                break
            except Exception:
                font_loaded = False

    if not font_loaded:
        pdf.set_font("Helvetica", style="B", size=14)
    pdf.cell(0, 9, "Service requests report", ln=1)
    pdf.set_font("UI" if font_loaded else "Helvetica", size=10)
    pdf.cell(0, 6, f"Status filter: {status or 'all'}", ln=1)
    pdf.cell(0, 6, f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}", ln=1)
    pdf.ln(2)

    headers = ["ID", "Title", "Status", "Last change", "Requester", "Opened", "Priority", "Category"]
    col_w = [16, 95, 22, 30, 40, 26, 22, 55]
    pdf.set_font("UI" if font_loaded else "Helvetica", style="B", size=9)
    for h, w in zip(headers, col_w):
        pdf.cell(w, 7, h, border=1)
    pdf.ln()

    pdf.set_font("UI" if font_loaded else "Helvetica", size=8)
    for t in rows:
        display_id = str(t.ticket_no) if t.ticket_no is not None else str(t.id)
        last_change_txt = _dt(t.glpi_updated_at or t.updated_at)
        opened_txt = _dt(t.opened_at)
        status_txt = (t.glpi_status or t.status or "")[:22]
        prio_txt = (t.glpi_priority or t.priority or "")[:22]
        title = (t.title or "").replace("\n", " ").strip()
        requester = (t.requester_name or "").replace("\n", " ").strip()
        category = (t.category or "").replace("\n", " ").strip()

        cells = [display_id, title, status_txt, last_change_txt, requester, opened_txt, prio_txt, category]
        for text, w in zip(cells, col_w):
            s = str(text)
            if len(s) > 120:
                s = s[:117] + "..."
            if not font_loaded:
                # Fallback for missing Unicode font: keep ASCII to avoid 500.
                s = s.encode("ascii", "ignore").decode("ascii")
            pdf.cell(w, 6, s, border=1)
        pdf.ln()

    out = pdf.output(dest="S")
    data = BytesIO(out if isinstance(out, (bytes, bytearray)) else out.encode("latin-1"))
    return StreamingResponse(
        data,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=service_requests_report.pdf"},
    )


@router.get("/templates", response_model=ServiceRequestTemplateListResponse)
async def list_templates(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(200, ge=1, le=1000),
):
    stmt = select(ServiceRequestTemplate).order_by(ServiceRequestTemplate.updated_at.desc(), ServiceRequestTemplate.id.desc()).limit(limit)
    r = await db.execute(stmt)
    rows = r.scalars().all()
    out = [await _template_to_out(db, x) for x in rows]
    total = int(await db.scalar(select(func.count()).select_from(ServiceRequestTemplate)) or 0)
    return ServiceRequestTemplateListResponse(items=out, total=total)


@router.post("/templates", response_model=ServiceRequestTemplateOut)
async def create_template(
    body: ServiceRequestTemplateCreate,
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = ServiceRequestTemplate(
        title=body.title.strip(),
        description=body.description,
        status=body.status,
        priority=body.priority,
        requester_name=(body.requester_name.strip() if body.requester_name else None),
        category=(body.category.strip() if body.category else None),
        computer_id=body.computer_id,
        opened_at=body.opened_at,
        planned_close_at=body.planned_close_at,
        closed_at=body.closed_at,
        created_by_id=current.id,
    )
    db.add(row)
    await db.flush()
    for uid in body.assignee_ids:
        await db.execute(service_request_template_assignees.insert().values(template_id=row.id, user_id=uid))
    await db.commit()
    await db.refresh(row)
    return await _template_to_out(db, row)


@router.patch("/templates/{template_id}", response_model=ServiceRequestTemplateOut)
async def patch_template(
    template_id: int,
    body: ServiceRequestTemplatePatch,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(ServiceRequestTemplate, template_id)
    if not row:
        raise HTTPException(status_code=404, detail="Шаблон не найден")
    patch = body.model_dump(exclude_unset=True)
    for k in [
        "title",
        "description",
        "status",
        "priority",
        "requester_name",
        "category",
        "computer_id",
        "opened_at",
        "planned_close_at",
        "closed_at",
    ]:
        if k in patch:
            setattr(row, k, patch[k])
    if "assignee_ids" in patch:
        await db.execute(
            delete(service_request_template_assignees).where(
                service_request_template_assignees.c.template_id == template_id
            )
        )
        for uid in patch["assignee_ids"] or []:
            await db.execute(service_request_template_assignees.insert().values(template_id=template_id, user_id=uid))
    await db.commit()
    await db.refresh(row)
    return await _template_to_out(db, row)


@router.post("/templates/{template_id}/delete")
async def delete_template(
    template_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(ServiceRequestTemplate, template_id)
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True}
