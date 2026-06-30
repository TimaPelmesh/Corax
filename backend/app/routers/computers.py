from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_current_user, get_current_editor_or_superuser
from app.database import get_db
from app.models import DiskVolume, Peripheral, Computer, InstalledSoftware, Tag, User, computer_tags
from app.peripheral_display import prepare_peripherals_for_display
from app.schemas import ComputerDetail, ComputerOut, ComputerUpdate, DiskVolume as DiskVolumeOut, PeripheralItem, SoftwareItem, TagBrief
import csv
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
_DRIVE_LETTER_RE = re.compile(r"^[A-Za-z]:$")


def _agent_extended_from_raw(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    ext = data.get("extended")
    return ext if isinstance(ext, dict) else None



async def _tags_for_computer(db: AsyncSession, computer_id: int) -> list[TagBrief]:
    """Без обхода ORM-коллекции .tags (в asyncio это даёт MissingGreenlet)."""
    r = await db.execute(
        select(Tag.id, Tag.name, Tag.color)
        .join(computer_tags, Tag.id == computer_tags.c.tag_id)
        .where(computer_tags.c.computer_id == computer_id)
        .order_by(Tag.name.asc())
    )
    return [TagBrief(id=int(row[0]), name=str(row[1]), color=row[2]) for row in r.all()]


async def _tags_for_computers_bulk(db: AsyncSession, computer_ids: list[int]) -> dict[int, list[TagBrief]]:
    if not computer_ids:
        return {}
    r = await db.execute(
        select(computer_tags.c.computer_id, Tag.id, Tag.name, Tag.color)
        .join(Tag, Tag.id == computer_tags.c.tag_id)
        .where(computer_tags.c.computer_id.in_(computer_ids))
        .order_by(computer_tags.c.computer_id.asc(), Tag.name.asc())
    )
    out: dict[int, list[TagBrief]] = {cid: [] for cid in computer_ids}
    for cid, tid, tname, tcolor in r.all():
        out[int(cid)].append(TagBrief(id=int(tid), name=str(tname), color=tcolor))
    return out

router = APIRouter(prefix="/computers", tags=["computers"])


@router.get("")
async def list_computers(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    skip: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=5000),
    q: str | None = Query(None),
    tag_ids: list[int] = Query(default=[]),
):
    sq_sw = (
        select(InstalledSoftware.computer_id, func.count().label("cnt"))
        .group_by(InstalledSoftware.computer_id)
        .subquery()
    )
    sq_pe = (
        select(Peripheral.computer_id, func.count().label("cnt"))
        .group_by(Peripheral.computer_id)
        .subquery()
    )
    stmt = (
        select(
            Computer,
            func.coalesce(sq_sw.c.cnt, 0).label("software_count"),
            func.coalesce(sq_pe.c.cnt, 0).label("peripheral_count"),
        )
        .outerjoin(sq_sw, Computer.id == sq_sw.c.computer_id)
        .outerjoin(sq_pe, Computer.id == sq_pe.c.computer_id)
    )
    if q and q.strip():
        stmt = stmt.where(Computer.hostname.ilike(f"%{q.strip()}%"))
    if tag_ids:
        stmt = stmt.join(computer_tags, computer_tags.c.computer_id == Computer.id).where(
            computer_tags.c.tag_id.in_(tag_ids)
        )
    total = int(
        await db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    )
    stmt = stmt.order_by(Computer.last_report_at.desc().nulls_last(), Computer.id).offset(skip).limit(limit)
    r = await db.execute(stmt)
    rows = r.unique().all()
    ids = [c.id for c, _, _ in rows]
    tags_by_pc = await _tags_for_computers_bulk(db, ids)
    out: list[ComputerOut] = []
    for c, sc, pc in rows:
        out.append(
            ComputerOut(
                id=c.id,
                hostname=c.hostname,
                serial_number=c.serial_number,
                mac_primary=c.mac_primary,
                cpu=c.cpu,
                ram_gb=c.ram_gb,
                os_name=c.os_name,
                os_version=c.os_version,
                manufacturer=c.manufacturer,
                model=c.model,
                location=c.location,
                gpu_name=c.gpu_name,
                memory_used_percent=c.memory_used_percent,
                motherboard_manufacturer=c.motherboard_manufacturer,
                motherboard_product=c.motherboard_product,
                disks=[],
                last_report_at=c.last_report_at,
                notes=c.notes,
                assigned_user_id=c.assigned_user_id,
                software_count=int(sc),
                peripheral_count=int(pc),
                tags=tags_by_pc.get(c.id, []),
            )
        )
    return {"items": out, "total": total}


def _csv_dt(v: datetime | None) -> str:
    if v is None:
        return ""
    if v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v.isoformat().replace("+00:00", "Z")


@router.get("/export.csv")
async def export_computers_csv(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    q: str | None = Query(None),
    tag_ids: list[int] = Query(default=[]),
):
    data = await list_computers(_, db, 0, 5000, q, tag_ids)
    buf = io.StringIO()
    wr = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    wr.writerow(
        [
            "id",
            "hostname",
            "location",
            "tags",
            "os_name",
            "os_version",
            "manufacturer",
            "model",
            "cpu",
            "ram_gb",
            "software_count",
            "peripheral_count",
            "last_report_at",
            "serial_number",
            "mac_primary",
            "notes",
            "assigned_user_id",
        ]
    )
    for r in data["items"]:
        tags = ", ".join(t.name for t in (r.tags or []))
        wr.writerow(
            [
                r.id,
                r.hostname or "",
                r.location or "",
                tags,
                r.os_name or "",
                r.os_version or "",
                r.manufacturer or "",
                r.model or "",
                r.cpu or "",
                r.ram_gb if r.ram_gb is not None else "",
                r.software_count,
                r.peripheral_count,
                _csv_dt(r.last_report_at),
                r.serial_number or "",
                r.mac_primary or "",
                (r.notes or "").replace("\r\n", "\n").replace("\r", "\n"),
                r.assigned_user_id if r.assigned_user_id is not None else "",
            ]
        )
    body = "\ufeff" + buf.getvalue()
    return StreamingResponse(
        iter([body.encode("utf-8")]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=computers_export.csv"},
    )


_GLPI_PC_REQUIRED_HEADERS = [
    "Наименование",
    "Организация",
    "Статус",
    "Производитель",
    "Модель",
    "Операционная система - Наименование",
    "Инвентарный номер",
    "Тип",
    "Последнее изменение",
    "Компоненты - Процессоры",
]
_GLPI_PC_DT_FMT = "%d-%m-%Y %H:%M"


def _parse_glpi_pc_dt(v: str | None) -> datetime | None:
    t = (v or "").strip()
    if not t:
        return None
    try:
        return datetime.strptime(t, _GLPI_PC_DT_FMT)
    except Exception:
        return None


def _read_text_best_effort(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    raise ValueError("Не удалось прочитать CSV (кодировка). Попробуйте UTF-8 или Windows-1251.")


@router.get("/export-glpi-pcs.csv")
async def export_glpi_pcs_csv(_: User = Depends(get_current_user)):
    """
    Export normalized list of PCs from a GLPI CSV file on the server filesystem.

    Expected source file location:
    - <project_root>/glpi_pcs.csv
    """
    project_root = Path(__file__).resolve().parents[3]
    src = project_root / "glpi_pcs.csv"
    if not src.is_file():
        raise HTTPException(
            status_code=404,
            detail="GLPI CSV с ПК не найден. Положите файл в корень проекта как glpi_pcs.csv.",
        )

    try:
        raw = src.read_bytes()
        text = _read_text_best_effort(raw)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Не удалось прочитать GLPI CSV: {exc}") from exc

    reader = csv.DictReader(text.splitlines(), delimiter=";", quotechar='"')
    headers = reader.fieldnames or []
    missing = [h for h in _GLPI_PC_REQUIRED_HEADERS if h not in headers]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"CSV не похож на GLPI (ПК): нет колонок: {', '.join(missing)}",
        )

    # Aggregate by hostname/device name: keep latest 'Последнее изменение' and the most informative non-empty fields.
    agg: dict[str, dict] = {}
    for row in reader:
        name = (row.get("Наименование") or "").strip()
        if not name:
            continue
        key = name.strip()
        dt = _parse_glpi_pc_dt(row.get("Последнее изменение"))
        cur = agg.get(key)
        if cur is None:
            cur = {
                "name": key,
                "org": None,
                "status": None,
                "manufacturer": None,
                "model": None,
                "os": None,
                "inv": None,
                "type": None,
                "last_change": None,
                "cpu": None,
            }
            agg[key] = cur

        prev_dt = cur.get("last_change")
        if prev_dt is None or (dt is not None and prev_dt is not None and dt > prev_dt) or (dt is not None and prev_dt is None):
            cur["last_change"] = dt

        def pick(field_key: str, source_col: str):
            v = (row.get(source_col) or "").strip()
            if not v:
                return
            if cur.get(field_key) is None or cur.get(field_key) == "":
                cur[field_key] = v
            # If current is "unknown-ish", replace with a better one.
            if isinstance(cur.get(field_key), str):
                low = str(cur[field_key]).strip().lower()
                if low in ("default string", "???"):
                    cur[field_key] = v

        pick("org", "Организация")
        pick("status", "Статус")
        pick("manufacturer", "Производитель")
        pick("model", "Модель")
        pick("os", "Операционная система - Наименование")
        pick("inv", "Инвентарный номер")
        pick("type", "Тип")
        pick("cpu", "Компоненты - Процессоры")

    buf = io.StringIO()
    wr = csv.writer(buf, delimiter=";")
    wr.writerow(
        [
            "hostname",
            "organization",
            "status",
            "manufacturer",
            "model",
            "os_name",
            "inventory_number",
            "type",
            "last_change",
            "cpu",
        ]
    )
    for k in sorted(agg.keys(), key=lambda s: s.lower()):
        r = agg[k]
        dt = r.get("last_change")
        wr.writerow(
            [
                r.get("name") or "",
                r.get("org") or "",
                r.get("status") or "",
                r.get("manufacturer") or "",
                r.get("model") or "",
                r.get("os") or "",
                r.get("inv") or "",
                r.get("type") or "",
                dt.strftime(_GLPI_PC_DT_FMT) if isinstance(dt, datetime) else "",
                r.get("cpu") or "",
            ]
        )

    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=glpi_pcs_export.csv"},
    )


@router.get("/{computer_id}", response_model=ComputerDetail)
async def get_computer(
    computer_id: int,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(
        select(Computer)
        .options(
            selectinload(Computer.software),
            selectinload(Computer.peripherals),
        )
        .where(Computer.id == computer_id)
    )
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="ПК не найден")
    sw = [SoftwareItem(name=s.name, version=s.version) for s in c.software]
    pe = [
        PeripheralItem(kind=k, name=n)
        for k, n in prepare_peripherals_for_display([(p.kind, p.name) for p in c.peripherals])
    ]
    rd = await db.execute(select(DiskVolume).where(DiskVolume.computer_id == computer_id))
    disks = [
        DiskVolumeOut(
            mount=d.mount,
            label=d.label,
            total_gb=d.total_gb,
            used_percent=d.used_percent,
            free_gb=d.free_gb,
        )
        for d in rd.scalars().all()
        if isinstance(d.mount, str) and _DRIVE_LETTER_RE.match(d.mount)
    ]
    cnt = len(sw)
    tags = await _tags_for_computer(db, computer_id)
    return ComputerDetail(
        id=c.id,
        hostname=c.hostname,
        serial_number=c.serial_number,
        mac_primary=c.mac_primary,
        cpu=c.cpu,
        ram_gb=c.ram_gb,
        os_name=c.os_name,
        os_version=c.os_version,
        manufacturer=c.manufacturer,
        model=c.model,
        location=c.location,
        gpu_name=c.gpu_name,
        memory_used_percent=c.memory_used_percent,
        motherboard_manufacturer=c.motherboard_manufacturer,
        motherboard_product=c.motherboard_product,
        disks=disks,
        last_report_at=c.last_report_at,
        notes=c.notes,
        assigned_user_id=c.assigned_user_id,
        software_count=cnt,
        peripheral_count=len(pe),
        software=sw,
        peripherals=pe,
        tags=tags,
        agent_extended=_agent_extended_from_raw(c.raw_payload),
    )


@router.delete("/{computer_id}", status_code=204)
async def delete_computer(
    computer_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Удаляет ПК и связанные записи ПО/периферии (каскадом). Только суперпользователь."""
    r = await db.execute(select(Computer.id).where(Computer.id == computer_id))
    if r.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="ПК не найден")
    await db.execute(delete(Computer).where(Computer.id == computer_id))
    await db.commit()


@router.patch("/{computer_id}", response_model=ComputerOut)
async def update_computer(
    computer_id: int,
    body: ComputerUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(Computer).where(Computer.id == computer_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="ПК не найден")
    if body.notes is not None:
        c.notes = body.notes
    if body.location is not None:
        c.location = body.location
    if body.assigned_user_id is not None:
        if body.assigned_user_id != 0:
            ur = await db.execute(select(User).where(User.id == body.assigned_user_id))
            if not ur.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="Пользователь не найден")
            c.assigned_user_id = body.assigned_user_id
        else:
            c.assigned_user_id = None
    if body.tag_ids is not None:
        ids_ordered = list(dict.fromkeys(body.tag_ids))
        if ids_ordered:
            tr = await db.execute(select(Tag.id).where(Tag.id.in_(ids_ordered)))
            found_ids = {int(row[0]) for row in tr.all()}
            if len(found_ids) != len(ids_ordered):
                raise HTTPException(status_code=400, detail="Неизвестный тег")
        await db.execute(delete(computer_tags).where(computer_tags.c.computer_id == computer_id))
        for tid in ids_ordered:
            await db.execute(
                insert(computer_tags).values(computer_id=computer_id, tag_id=tid)
            )
    await db.commit()

    cnt_r = await db.execute(
        select(func.count()).select_from(InstalledSoftware).where(InstalledSoftware.computer_id == computer_id)
    )
    sc = int(cnt_r.scalar_one() or 0)
    cnt_pe = await db.execute(
        select(func.count()).select_from(Peripheral).where(Peripheral.computer_id == computer_id)
    )
    pc = int(cnt_pe.scalar_one() or 0)
    r_pc = await db.execute(select(Computer).where(Computer.id == computer_id))
    c2 = r_pc.scalar_one()
    tags = await _tags_for_computer(db, computer_id)
    return ComputerOut(
        id=c2.id,
        hostname=c2.hostname,
        serial_number=c2.serial_number,
        mac_primary=c2.mac_primary,
        cpu=c2.cpu,
        ram_gb=c2.ram_gb,
        os_name=c2.os_name,
        os_version=c2.os_version,
        manufacturer=c2.manufacturer,
        model=c2.model,
        location=c2.location,
        gpu_name=c2.gpu_name,
        memory_used_percent=c2.memory_used_percent,
        motherboard_manufacturer=c2.motherboard_manufacturer,
        motherboard_product=c2.motherboard_product,
        disks=[],
        last_report_at=c2.last_report_at,
        notes=c2.notes,
        assigned_user_id=c2.assigned_user_id,
        software_count=sc,
        peripheral_count=pc,
        tags=tags,
    )


@router.get("/{computer_id}/history")
async def computer_history(
    computer_id: int,
    _: User = Depends(get_current_user),
    limit: int = Query(100, ge=1, le=500),
):
    _ = (computer_id, limit)
    return []


@router.post("/import-glpi-pcs-csv")
async def import_glpi_pcs_csv(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
    file: UploadFile = File(...),
):
    """
    Upload GLPI PCs CSV to server filesystem as <project_root>/glpi_pcs.csv.
    Then import/update computers in DB (by hostname).
    """
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Ожидается CSV файл (.csv).")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл.")

    try:
        text = _read_text_best_effort(raw)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    reader = csv.DictReader(text.splitlines(), delimiter=";", quotechar='"')
    headers = reader.fieldnames or []
    missing = [h for h in _GLPI_PC_REQUIRED_HEADERS if h not in headers]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"CSV не похож на GLPI (ПК): нет колонок: {', '.join(missing)}",
        )

    # Aggregate by hostname/device name: keep latest 'Последнее изменение' and the most informative non-empty fields.
    agg: dict[str, dict] = {}
    rows_total = 0
    for row in reader:
        rows_total += 1
        name = (row.get("Наименование") or "").strip()
        if not name:
            continue
        key = name.strip()
        dt = _parse_glpi_pc_dt(row.get("Последнее изменение"))
        cur = agg.get(key)
        if cur is None:
            cur = {
                "name": key,
                "org": None,
                "status": None,
                "manufacturer": None,
                "model": None,
                "os": None,
                "inv": None,
                "type": None,
                "last_change": None,
                "cpu": None,
            }
            agg[key] = cur

        prev_dt = cur.get("last_change")
        if prev_dt is None or (dt is not None and prev_dt is not None and dt > prev_dt) or (dt is not None and prev_dt is None):
            cur["last_change"] = dt

        def pick(field_key: str, source_col: str):
            v = (row.get(source_col) or "").strip()
            if not v:
                return
            if cur.get(field_key) is None or cur.get(field_key) == "":
                cur[field_key] = v
            if isinstance(cur.get(field_key), str):
                low = str(cur[field_key]).strip().lower()
                if low in ("default string", "???"):
                    cur[field_key] = v

        pick("org", "Организация")
        pick("status", "Статус")
        pick("manufacturer", "Производитель")
        pick("model", "Модель")
        pick("os", "Операционная система - Наименование")
        pick("inv", "Инвентарный номер")
        pick("type", "Тип")
        pick("cpu", "Компоненты - Процессоры")

    project_root = Path(__file__).resolve().parents[3]
    dst = project_root / "glpi_pcs.csv"
    try:
        dst.write_bytes(raw)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Не удалось сохранить файл на сервере: {exc}") from exc

    created = 0
    updated = 0
    skipped = 0
    for hn, r in agg.items():
        hn_clean = (hn or "").strip()
        if not hn_clean:
            skipped += 1
            continue
        hn_key = hn_clean.lower()
        q = await db.execute(select(Computer).where(func.lower(Computer.hostname) == hn_key).limit(1))
        pc = q.scalar_one_or_none()

        inv = (r.get("inv") or "").strip() or None
        org = (r.get("org") or "").strip() or None
        status = (r.get("status") or "").strip() or None
        kind = (r.get("type") or "").strip() or None
        notes = None
        notes_bits: list[str] = []
        if org:
            notes_bits.append(f"org={org}")
        if status:
            notes_bits.append(f"status={status}")
        if kind:
            notes_bits.append(f"type={kind}")
        if inv:
            notes_bits.append(f"inv={inv}")
        if notes_bits:
            notes = "GLPI: " + "; ".join(notes_bits)

        def _dt_utc(v: datetime | None) -> datetime | None:
            if v is None:
                return None
            if v.tzinfo is None:
                return v.replace(tzinfo=timezone.utc)
            return v

        dt = _dt_utc(r.get("last_change") if isinstance(r.get("last_change"), datetime) else None)

        if pc:
            changed = False
            # Keep hostname as-is, update metadata fields.
            if inv and not pc.serial_number:
                pc.serial_number = inv[:128]
                changed = True
            if r.get("manufacturer") and pc.manufacturer != r.get("manufacturer"):
                pc.manufacturer = str(r.get("manufacturer"))[:255]
                changed = True
            if r.get("model") and pc.model != r.get("model"):
                pc.model = str(r.get("model"))[:255]
                changed = True
            if r.get("os") and pc.os_name != r.get("os"):
                pc.os_name = str(r.get("os"))[:255]
                changed = True
            if r.get("cpu") and pc.cpu != r.get("cpu"):
                pc.cpu = str(r.get("cpu"))[:512]
                changed = True
            if org and (pc.location is None or not str(pc.location).strip()):
                pc.location = org[:255]
                changed = True
            if notes and (pc.notes is None or not str(pc.notes).strip()):
                pc.notes = notes
                changed = True
            if dt is not None:
                prev = _dt_utc(pc.last_report_at)
                if prev is None or dt > prev:
                    pc.last_report_at = dt
                    changed = True
            if changed:
                updated += 1
            else:
                skipped += 1
        else:
            pc = Computer(
                hostname=hn_clean[:255],
                serial_number=(inv[:128] if inv else None),
                cpu=(str(r.get("cpu"))[:512] if r.get("cpu") else None),
                os_name=(str(r.get("os"))[:255] if r.get("os") else None),
                manufacturer=(str(r.get("manufacturer"))[:255] if r.get("manufacturer") else None),
                model=(str(r.get("model"))[:255] if r.get("model") else None),
                location=(org[:255] if org else None),
                notes=notes,
                last_report_at=(dt if isinstance(dt, datetime) else None),
            )
            db.add(pc)
            created += 1

    await db.commit()

    return {
        "filename": file.filename,
        "saved_as": str(dst.name),
        "rows_total": rows_total,
        "unique_names": len(agg),
        "created": created,
        "updated": updated,
        "skipped": skipped,
    }
