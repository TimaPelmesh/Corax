from __future__ import annotations

import csv
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_superuser, get_current_user
from app.database import get_db
from app.models import Monitor, User

router = APIRouter(prefix="/monitors", tags=["monitors"])

_GLPI_MON_REQUIRED_HEADERS = [
    "Наименование",
    "Организация",
    "Производитель",
    "Инвентарный номер",
    "Последнее изменение",
    "Контактное лицо",
    "Модель",
    "Серийный номер",
]

_GLPI_MON_DT_FMT = "%d-%m-%Y %H:%M"


def _parse_glpi_dt(v: str | None) -> datetime | None:
    t = (v or "").strip()
    if not t:
        return None
    try:
        dt = datetime.strptime(t, _GLPI_MON_DT_FMT)
        # Keep consistent with other parts of the app: treat naive as UTC.
        return dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _read_text_best_effort(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    raise ValueError("Не удалось прочитать CSV (кодировка). Попробуйте UTF-8 или Windows-1251.")


def _username_from_contact(contact_raw: str | None) -> str | None:
    """
    GLPI 'Контактное лицо' examples:
    - jdoe@LAB
    - jane.smith@example.com
    - Admin@SITE
    """
    s = (contact_raw or "").strip()
    if not s:
        return None
    if "@" in s:
        left = s.split("@", 1)[0].strip()
        return left or None
    return s or None


@router.get("")
async def list_monitors(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    assigned_user_id: int | None = None,
    limit: int = 2000,
):
    stmt = select(Monitor).order_by(Monitor.id.desc())
    if assigned_user_id is not None:
        stmt = stmt.where(Monitor.assigned_user_id == assigned_user_id)
    stmt = stmt.limit(max(1, min(int(limit or 2000), 5000)))
    r = await db.execute(stmt)
    rows = r.scalars().all()
    return [
        {
            "id": m.id,
            "name": m.name,
            "manufacturer": m.manufacturer,
            "model": m.model,
            "serial_number": m.serial_number,
            "inventory_number": m.inventory_number,
            "organization": m.organization,
            "glpi_contact_raw": m.glpi_contact_raw,
            "assigned_user_id": m.assigned_user_id,
            "glpi_updated_at": (m.glpi_updated_at.isoformat().replace("+00:00", "Z") if m.glpi_updated_at else None),
        }
        for m in rows
    ]


@router.post("/import-glpi-csv")
async def import_glpi_monitors_csv(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
    file: UploadFile = File(...),
):
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
    missing = [h for h in _GLPI_MON_REQUIRED_HEADERS if h not in headers]
    if missing:
        raise HTTPException(status_code=400, detail=f"CSV не похож на GLPI (мониторы): нет колонок: {', '.join(missing)}")

    # Cache usernames for quick matching.
    users = await db.execute(select(User.id, User.username))
    user_by_username = {str(u).strip().lower(): int(uid) for uid, u in users.all() if u}

    created = 0
    updated = 0
    skipped = 0
    rows_total = 0
    linked_users = 0
    unlinked_rows = 0

    for row in reader:
        rows_total += 1
        name = (row.get("Наименование") or "").strip() or None
        if not name:
            skipped += 1
            continue

        manufacturer = (row.get("Производитель") or "").strip() or None
        model = (row.get("Модель") or "").strip() or None
        serial = (row.get("Серийный номер") or "").strip() or None
        inv = (row.get("Инвентарный номер") or "").strip() or None
        org = (row.get("Организация") or "").strip() or None
        contact_raw = (row.get("Контактное лицо") or "").strip() or None
        glpi_dt = _parse_glpi_dt(row.get("Последнее изменение"))

        username = _username_from_contact(contact_raw)
        assigned_user_id = user_by_username.get(username.lower()) if username else None
        if assigned_user_id is not None:
            linked_users += 1
        else:
            unlinked_rows += 1

        # Upsert key priority: serial_number -> inventory_number -> (name+model+assigned_user_id)
        m: Monitor | None = None
        if serial:
            q = await db.execute(select(Monitor).where(Monitor.serial_number == serial).limit(1))
            m = q.scalar_one_or_none()
        if m is None and inv:
            q = await db.execute(select(Monitor).where(Monitor.inventory_number == inv).limit(1))
            m = q.scalar_one_or_none()
        if m is None:
            stmt = select(Monitor).where(func.lower(Monitor.name) == name.lower())
            if model:
                stmt = stmt.where(func.lower(func.coalesce(Monitor.model, "")) == model.lower())
            if assigned_user_id is None:
                stmt = stmt.where(Monitor.assigned_user_id.is_(None))
            else:
                stmt = stmt.where(Monitor.assigned_user_id == assigned_user_id)
            q = await db.execute(stmt.limit(1))
            m = q.scalar_one_or_none()

        if m is None:
            m = Monitor(
                name=name[:255],
                manufacturer=manufacturer[:255] if manufacturer else None,
                model=model[:255] if model else None,
                serial_number=serial[:128] if serial else None,
                inventory_number=inv[:128] if inv else None,
                organization=org[:255] if org else None,
                glpi_contact_raw=contact_raw[:255] if contact_raw else None,
                assigned_user_id=assigned_user_id,
                glpi_updated_at=glpi_dt,
            )
            db.add(m)
            created += 1
            continue

        changed = False
        if manufacturer and m.manufacturer != manufacturer:
            m.manufacturer = manufacturer[:255]
            changed = True
        if model and m.model != model:
            m.model = model[:255]
            changed = True
        if serial and not m.serial_number:
            m.serial_number = serial[:128]
            changed = True
        if inv and not m.inventory_number:
            m.inventory_number = inv[:128]
            changed = True
        if org and not m.organization:
            m.organization = org[:255]
            changed = True
        if contact_raw and not m.glpi_contact_raw:
            m.glpi_contact_raw = contact_raw[:255]
            changed = True
        if m.assigned_user_id is None and assigned_user_id is not None:
            m.assigned_user_id = assigned_user_id
            changed = True
        if glpi_dt is not None and (m.glpi_updated_at is None or glpi_dt > (m.glpi_updated_at.replace(tzinfo=timezone.utc) if m.glpi_updated_at.tzinfo is None else m.glpi_updated_at)):
            m.glpi_updated_at = glpi_dt
            changed = True

        if changed:
            updated += 1
        else:
            skipped += 1

    await db.commit()
    return {
        "ok": True,
        "filename": file.filename,
        "rows_total": rows_total,
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "linked_users": linked_users,
        "unlinked_rows": unlinked_rows,
    }

