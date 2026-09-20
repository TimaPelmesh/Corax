from __future__ import annotations

import json
import re
from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_editor_or_superuser, get_current_superuser, get_current_user
from app.database import get_db, get_warehouse_db
from app.models import User
from app.warehouse_csv import merge_consumable_rows, parse_warehouse_csv, read_text_best_effort, render_warehouse_csv
from app.warehouse_models import StockItem, StockMovement, WarehouseRoom

router = APIRouter(prefix="/warehouse", tags=["warehouse"])

WAREHOUSE_PRESETS: list[dict[str, str]] = [
    {"key": "ram", "name": "ОЗУ", "group": "components", "default_tracking": "lot"},
    {"key": "ssd", "name": "SSD", "group": "components", "default_tracking": "lot"},
    {"key": "hdd", "name": "HDD", "group": "components", "default_tracking": "lot"},
    {"key": "cpu", "name": "Процессор", "group": "components", "default_tracking": "lot"},
    {"key": "gpu", "name": "Видеокарта", "group": "components", "default_tracking": "lot"},
    {"key": "motherboard", "name": "Материнская плата", "group": "components", "default_tracking": "lot"},
    {"key": "psu", "name": "Блок питания", "group": "components", "default_tracking": "lot"},
    {"key": "case", "name": "Корпус", "group": "components", "default_tracking": "lot"},
    {"key": "cooler", "name": "Кулер / охлаждение", "group": "components", "default_tracking": "lot"},
    {"key": "optical", "name": "Оптический привод", "group": "components", "default_tracking": "lot"},
    {"key": "printer", "name": "Принтер", "group": "peripherals", "default_tracking": "lot"},
    {"key": "mouse", "name": "Мышь", "group": "peripherals", "default_tracking": "lot"},
    {"key": "keyboard", "name": "Клавиатура", "group": "peripherals", "default_tracking": "lot"},
    {"key": "headset", "name": "Гарнитура", "group": "peripherals", "default_tracking": "lot"},
    {"key": "webcam", "name": "Веб-камера", "group": "peripherals", "default_tracking": "lot"},
    {"key": "cartridge", "name": "Картридж / тонер", "group": "peripherals", "default_tracking": "lot"},
    {"key": "docking", "name": "Док-станция", "group": "peripherals", "default_tracking": "lot"},
    {"key": "ups", "name": "ИБП", "group": "peripherals", "default_tracking": "lot"},
    {"key": "cable_usb", "name": "Кабель USB / адаптер", "group": "peripherals", "default_tracking": "lot"},
    {"key": "switch", "name": "Коммутатор", "group": "network", "default_tracking": "lot"},
    {"key": "ap", "name": "Точка доступа", "group": "network", "default_tracking": "lot"},
    {"key": "router", "name": "Маршрутизатор", "group": "network", "default_tracking": "lot"},
    {"key": "patch_cord", "name": "Патч-корд / кабель", "group": "network", "default_tracking": "lot"},
    {"key": "monitor", "name": "Монитор", "group": "other", "default_tracking": "lot"},
    {"key": "peripheral", "name": "Периферия (прочее)", "group": "other", "default_tracking": "lot"},
    {"key": "other", "name": "Прочее", "group": "other", "default_tracking": "lot"},
]

PRESET_BY_KEY = {p["key"]: p for p in WAREHOUSE_PRESETS}


class WarehousePresetOut(BaseModel):
    key: str
    name: str
    group: str
    default_tracking: str


class WarehouseRoomOut(BaseModel):
    id: int
    title: str
    sort_order: int
    notes: str | None
    item_count: int = 0
    created_at: datetime | None
    updated_at: datetime | None


class WarehouseRoomCreate(BaseModel):
    title: str = Field(default="Склад", max_length=255)
    notes: str | None = None


class WarehouseRoomPatch(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    notes: str | None = None
    sort_order: int | None = None


class StockItemOut(BaseModel):
    id: int
    room_id: int
    preset_key: str
    preset_name: str | None = None
    name: str
    tracking_mode: str
    quantity: int
    quantity_available: int
    internal_code: str | None
    status: str
    condition: str
    manufacturer: str | None = None
    external_id: str | None = None
    serial_number: str | None
    batch_label: str | None
    attributes_json: str | None
    notes: str | None
    created_by_id: int | None
    created_at: datetime | None
    updated_at: datetime | None


class StockItemCreate(BaseModel):
    room_id: int
    preset_key: str = Field(default="custom", max_length=32)
    name: str = Field(min_length=1, max_length=512)
    tracking_mode: str = Field(default="lot", pattern="^(unit|lot)$")
    quantity: int = Field(default=1, ge=1, le=9999)
    internal_code: str | None = Field(default=None, max_length=32)
    condition: str = Field(default="new", pattern="^(new|used|defective)$")
    manufacturer: str | None = Field(default=None, max_length=255)
    external_id: str | None = Field(default=None, max_length=64)
    serial_number: str | None = Field(default=None, max_length=128)
    batch_label: str | None = Field(default=None, max_length=255)
    attributes_json: str | None = None
    notes: str | None = None
    auto_code: bool = False


class StockItemPatch(BaseModel):
    name: str | None = Field(default=None, max_length=512)
    quantity: int | None = Field(default=None, ge=1, le=9999)
    condition: str | None = Field(default=None, pattern="^(new|used|defective)$")
    manufacturer: str | None = Field(default=None, max_length=255)
    serial_number: str | None = Field(default=None, max_length=128)
    batch_label: str | None = Field(default=None, max_length=255)
    attributes_json: str | None = None
    notes: str | None = None


class StockTransferBody(BaseModel):
    to_room_id: int
    comment: str | None = None


class StockMovementOut(BaseModel):
    id: int
    item_id: int
    item_name: str | None = None
    item_code: str | None = None
    manufacturer: str | None = None
    tracking_mode: str | None = None
    movement_kind: str
    quantity: int
    from_room_id: int | None
    to_room_id: int | None
    from_room_title: str | None = None
    to_room_title: str | None = None
    service_request_id: int | None
    computer_id: int | None
    comment: str | None
    created_by_id: int | None
    created_by_name: str | None = None
    created_at: datetime | None


def _preset_name(key: str) -> str | None:
    p = PRESET_BY_KEY.get(key)
    return p["name"] if p else None


def _item_out(row: StockItem) -> StockItemOut:
    return StockItemOut(
        id=row.id,
        room_id=row.room_id,
        preset_key=row.preset_key,
        preset_name=_preset_name(row.preset_key),
        name=row.name,
        tracking_mode=row.tracking_mode,
        quantity=row.quantity,
        quantity_available=row.quantity_available,
        internal_code=row.internal_code,
        status=row.status,
        condition=row.condition,
        manufacturer=row.manufacturer,
        external_id=row.external_id,
        serial_number=row.serial_number,
        batch_label=row.batch_label,
        attributes_json=row.attributes_json,
        notes=row.notes,
        created_by_id=row.created_by_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _next_internal_code(db: AsyncSession) -> str:
    rows = (
        await db.execute(
            select(StockItem.internal_code).where(StockItem.internal_code.is_not(None)).order_by(StockItem.id.desc()).limit(500)
        )
    ).scalars().all()
    max_n = 0
    for code in rows:
        if not code:
            continue
        m = re.match(r"^СК-(\d+)$", code.strip(), re.IGNORECASE)
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f"СК-{max_n + 1:04d}"


async def _room_item_counts(db: AsyncSession, room_ids: list[int]) -> dict[int, int]:
    if not room_ids:
        return {}
    r = await db.execute(
        select(StockItem.room_id, func.coalesce(func.sum(StockItem.quantity_available), 0))
        .where(StockItem.room_id.in_(room_ids), StockItem.status != "written_off")
        .group_by(StockItem.room_id)
    )
    return {int(room_id): int(qty or 0) for room_id, qty in r.all()}


async def _log_movement(
    db: AsyncSession,
    *,
    item_id: int,
    movement_kind: str,
    quantity: int,
    from_room_id: int | None,
    to_room_id: int | None,
    created_by_id: int | None,
    comment: str | None = None,
    payload: dict | None = None,
) -> None:
    db.add(
        StockMovement(
            item_id=item_id,
            movement_kind=movement_kind,
            quantity=quantity,
            from_room_id=from_room_id,
            to_room_id=to_room_id,
            comment=comment,
            created_by_id=created_by_id,
            payload_json=json.dumps(payload, ensure_ascii=False) if payload else None,
        )
    )


@router.get("/presets", response_model=list[WarehousePresetOut])
async def list_presets(_: User = Depends(get_current_user)):
    return [WarehousePresetOut(**p) for p in WAREHOUSE_PRESETS]


@router.get("/rooms", response_model=list[WarehouseRoomOut])
async def list_rooms(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_warehouse_db)):
    rows = (await db.execute(select(WarehouseRoom).order_by(WarehouseRoom.sort_order.asc(), WarehouseRoom.id.asc()))).scalars().all()
    counts = await _room_item_counts(db, [r.id for r in rows])
    return [
        WarehouseRoomOut(
            id=r.id,
            title=r.title,
            sort_order=r.sort_order,
            notes=r.notes,
            item_count=counts.get(r.id, 0),
            created_at=r.created_at,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.post("/rooms", response_model=WarehouseRoomOut)
async def create_room(
    body: WarehouseRoomCreate,
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    title = body.title.strip() or "Склад"
    max_sort = await db.scalar(select(func.coalesce(func.max(WarehouseRoom.sort_order), 0)))
    row = WarehouseRoom(title=title, sort_order=int(max_sort or 0) + 1, notes=(body.notes or "").strip() or None)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return WarehouseRoomOut(
        id=row.id,
        title=row.title,
        sort_order=row.sort_order,
        notes=row.notes,
        item_count=0,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.patch("/rooms/{room_id}", response_model=WarehouseRoomOut)
async def patch_room(
    room_id: int,
    body: WarehouseRoomPatch,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    row = await db.get(WarehouseRoom, room_id)
    if not row:
        raise HTTPException(status_code=404, detail="Помещение не найдено")
    if body.title is not None:
        t = body.title.strip()
        if t:
            row.title = t
    if body.notes is not None:
        row.notes = body.notes.strip() or None
    if body.sort_order is not None:
        row.sort_order = body.sort_order
    await db.commit()
    await db.refresh(row)
    counts = await _room_item_counts(db, [row.id])
    return WarehouseRoomOut(
        id=row.id,
        title=row.title,
        sort_order=row.sort_order,
        notes=row.notes,
        item_count=counts.get(row.id, 0),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.delete("/rooms/{room_id}", status_code=204)
async def delete_room(
    room_id: int,
    purge: bool = Query(default=False),
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    row = await db.get(WarehouseRoom, room_id)
    if not row:
        raise HTTPException(status_code=404, detail="Помещение не найдено")

    live = await db.scalar(
        select(func.count())
        .select_from(StockItem)
        .where(StockItem.room_id == room_id, StockItem.status != "written_off")
    )
    if live and live > 0 and not purge:
        raise HTTPException(
            status_code=409,
            detail="Нельзя удалить помещение с позициями на складе — сначала перенесите или спишите их, либо удалите всё сразу",
        )

    item_ids = (
        await db.execute(select(StockItem.id).where(StockItem.room_id == room_id))
    ).scalars().all()
    if item_ids:
        await db.execute(delete(StockMovement).where(StockMovement.item_id.in_(item_ids)))
    await db.execute(
        delete(StockMovement).where(
            (StockMovement.from_room_id == room_id) | (StockMovement.to_room_id == room_id)
        )
    )
    if item_ids:
        await db.execute(delete(StockItem).where(StockItem.id.in_(item_ids)))

    try:
        await db.delete(row)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Нельзя удалить помещение: остались связанные позиции. Перенесите или удалите их.",
        ) from None


@router.get("/items", response_model=list[StockItemOut])
async def list_items(
    room_id: int | None = Query(default=None),
    status: str | None = Query(default=None),
    preset_key: str | None = Query(default=None),
    q: str | None = Query(default=None),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_warehouse_db),
):
    stmt = select(StockItem).order_by(StockItem.updated_at.desc(), StockItem.id.desc())
    if room_id is not None:
        stmt = stmt.where(StockItem.room_id == room_id)
    if status:
        stmt = stmt.where(StockItem.status == status.strip())
    else:
        stmt = stmt.where(StockItem.status != "written_off")
    if preset_key:
        stmt = stmt.where(StockItem.preset_key == preset_key.strip())
    if q and q.strip():
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            func.lower(StockItem.name).like(needle)
            | func.lower(func.coalesce(StockItem.internal_code, "")).like(needle)
            | func.lower(func.coalesce(StockItem.manufacturer, "")).like(needle)
            | func.lower(func.coalesce(StockItem.batch_label, "")).like(needle)
            | func.lower(func.coalesce(StockItem.notes, "")).like(needle)
            | func.lower(func.coalesce(StockItem.serial_number, "")).like(needle)
            | func.lower(func.coalesce(StockItem.external_id, "")).like(needle)
        )
    rows = (await db.execute(stmt.limit(500))).scalars().all()
    return [_item_out(r) for r in rows]


@router.post("/items", response_model=StockItemOut)
async def create_item(
    body: StockItemCreate,
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    room = await db.get(WarehouseRoom, body.room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Помещение не найдено")
    preset_key = body.preset_key.strip() or "custom"
    if preset_key not in PRESET_BY_KEY:
        preset_key = "custom"
    tracking = "lot"
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Укажите название / модель")
    requested_qty = max(1, min(int(body.quantity or 1), 9999))
    shared_code = (body.internal_code or "").strip() or None
    serial = (body.serial_number or "").strip() or None
    batch = (body.batch_label or "").strip() or None
    notes = (body.notes or "").strip() or None
    manufacturer = (body.manufacturer or "").strip() or None
    external_id = (body.external_id or "").strip() or None

    async def _alloc_code(explicit: str | None) -> str | None:
        code = explicit
        if body.auto_code and not code:
            code = await _next_internal_code(db)
        if code:
            dup = await db.scalar(select(StockItem.id).where(StockItem.internal_code == code).limit(1))
            if dup:
                raise HTTPException(status_code=409, detail=f"Код {code} уже используется")
        return code

    # One row with a shelf quantity (ОЗУ, тонер, кабели — одинаково).
    create_count = 1
    row_qty = requested_qty
    last: StockItem | None = None
    for i in range(create_count):
        # explicit internal_code only for a single unit; multi-unit always auto/unique
        code_in = shared_code if create_count == 1 else None
        internal_code = await _alloc_code(code_in)
        row = StockItem(
            room_id=body.room_id,
            preset_key=preset_key,
            name=name,
            tracking_mode=tracking,
            quantity=row_qty,
            quantity_available=row_qty,
            internal_code=internal_code,
            status="available",
            condition=body.condition,
            manufacturer=manufacturer,
            external_id=external_id if create_count == 1 else None,
            serial_number=serial if create_count == 1 else None,
            batch_label=batch,
            attributes_json=body.attributes_json,
            notes=notes,
            created_by_id=current.id,
        )
        db.add(row)
        await db.flush()
        await _log_movement(
            db,
            item_id=row.id,
            movement_kind="receipt",
            quantity=row_qty,
            from_room_id=None,
            to_room_id=body.room_id,
            created_by_id=current.id,
            comment="Приход на склад",
            payload={"preset_key": preset_key, "name": row.name, "index": i + 1, "of": create_count},
        )
        last = row

    await db.commit()
    assert last is not None
    await db.refresh(last)
    return _item_out(last)


@router.patch("/items/{item_id}", response_model=StockItemOut)
async def patch_item(
    item_id: int,
    body: StockItemPatch,
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    row = await db.get(StockItem, item_id)
    if not row:
        raise HTTPException(status_code=404, detail="Позиция не найдена")
    if row.status == "written_off":
        raise HTTPException(status_code=409, detail="Позиция списана")
    old_qty = int(row.quantity_available if row.quantity_available is not None else row.quantity or 0)
    if body.name is not None:
        t = body.name.strip()
        if t:
            row.name = t
    if body.quantity is not None:
        row.tracking_mode = "lot"
        row.quantity = body.quantity
        row.quantity_available = body.quantity
    if body.condition is not None:
        row.condition = body.condition
    if body.manufacturer is not None:
        row.manufacturer = body.manufacturer.strip() or None
    if body.serial_number is not None:
        row.serial_number = body.serial_number.strip() or None
    if body.batch_label is not None:
        row.batch_label = body.batch_label.strip() or None
    if body.attributes_json is not None:
        row.attributes_json = body.attributes_json
    if body.notes is not None:
        row.notes = body.notes.strip() or None
    if body.quantity is not None and body.quantity != old_qty:
        delta = body.quantity - old_qty
        await _log_movement(
            db,
            item_id=row.id,
            movement_kind="adjust",
            quantity=abs(delta),
            from_room_id=row.room_id,
            to_room_id=row.room_id,
            created_by_id=current.id,
            comment="Приход на склад" if delta > 0 else "Корректировка количества",
            payload={"old_quantity": old_qty, "new_quantity": body.quantity, "delta": delta},
        )
    await db.commit()
    await db.refresh(row)
    return _item_out(row)


@router.post("/items/{item_id}/transfer", response_model=StockItemOut)
async def transfer_item(
    item_id: int,
    body: StockTransferBody,
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    row = await db.get(StockItem, item_id)
    if not row:
        raise HTTPException(status_code=404, detail="Позиция не найдена")
    if row.status == "written_off":
        raise HTTPException(status_code=409, detail="Позиция списана")
    if body.to_room_id == row.room_id:
        raise HTTPException(status_code=400, detail="Позиция уже в этом помещении")
    dest = await db.get(WarehouseRoom, body.to_room_id)
    if not dest:
        raise HTTPException(status_code=404, detail="Целевое помещение не найдено")
    from_room = row.room_id
    row.room_id = body.to_room_id
    await _log_movement(
        db,
        item_id=row.id,
        movement_kind="transfer",
        quantity=row.quantity,
        from_room_id=from_room,
        to_room_id=body.to_room_id,
        created_by_id=current.id,
        comment=(body.comment or "").strip() or "Перемещение между помещениями",
    )
    await db.commit()
    await db.refresh(row)
    return _item_out(row)


@router.post("/items/{item_id}/write-off", response_model=StockItemOut)
async def write_off_item(
    item_id: int,
    comment: str | None = Query(default=None),
    quantity: int | None = Query(default=None, ge=1, le=9999),
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    row = await db.get(StockItem, item_id)
    if not row:
        raise HTTPException(status_code=404, detail="Позиция не найдена")
    if row.status == "written_off":
        raise HTTPException(status_code=409, detail="Уже списано")
    available = max(0, int(row.quantity_available or 0))
    if available <= 0:
        raise HTTPException(status_code=409, detail="На складе уже 0 шт")
    qty = available if quantity is None else int(quantity)
    if qty > available:
        raise HTTPException(
            status_code=400,
            detail=f"Нельзя списать {qty} шт — на складе {available} шт",
        )
    row.quantity_available = available - qty
    if row.quantity_available <= 0:
        row.status = "written_off"
        row.quantity_available = 0
    await _log_movement(
        db,
        item_id=row.id,
        movement_kind="write_off",
        quantity=qty,
        from_room_id=row.room_id,
        to_room_id=None,
        created_by_id=current.id,
        comment=(comment or "").strip() or ("Списание всего" if qty == available else f"Списание {qty} шт"),
        payload={"remaining": row.quantity_available, "full": row.status == "written_off"},
    )
    await db.commit()
    await db.refresh(row)
    return _item_out(row)


@router.delete("/items/{item_id}", status_code=204)
async def delete_item(
    item_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    row = await db.get(StockItem, item_id)
    if not row:
        raise HTTPException(status_code=404, detail="Позиция не найдена")
    await db.execute(delete(StockMovement).where(StockMovement.item_id == item_id))
    await db.delete(row)
    await db.commit()


@router.get("/movements", response_model=list[StockMovementOut])
async def list_movements(
    item_id: int | None = Query(default=None),
    room_id: int | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_warehouse_db),
    inventory_db: AsyncSession = Depends(get_db),
):
    stmt = select(StockMovement).order_by(StockMovement.created_at.desc(), StockMovement.id.desc())
    if item_id is not None:
        stmt = stmt.where(StockMovement.item_id == item_id)
    elif room_id is not None:
        stmt = stmt.where((StockMovement.from_room_id == room_id) | (StockMovement.to_room_id == room_id))
    rows = (await db.execute(stmt.limit(limit))).scalars().all()
    item_ids = {m.item_id for m in rows}
    items: dict[int, StockItem] = {}
    if item_ids:
        items = {
            row.id: row
            for row in (await db.execute(select(StockItem).where(StockItem.id.in_(item_ids)))).scalars().all()
        }
    room_ids = {rid for m in rows for rid in (m.from_room_id, m.to_room_id) if rid is not None}
    rooms: dict[int, WarehouseRoom] = {}
    if room_ids:
        rooms = {
            row.id: row
            for row in (await db.execute(select(WarehouseRoom).where(WarehouseRoom.id.in_(room_ids)))).scalars().all()
        }
    user_ids = {m.created_by_id for m in rows if m.created_by_id}
    users: dict[int, str] = {}
    if user_ids:
        user_rows = (await inventory_db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
        users = {u.id: (u.full_name or u.username) for u in user_rows}
    return [
        StockMovementOut(
            id=m.id,
            item_id=m.item_id,
            item_name=(items[m.item_id].name if m.item_id in items else None),
            item_code=(items[m.item_id].internal_code if m.item_id in items else None),
            manufacturer=(items[m.item_id].manufacturer if m.item_id in items else None),
            tracking_mode=(items[m.item_id].tracking_mode if m.item_id in items else None),
            movement_kind=m.movement_kind,
            quantity=m.quantity,
            from_room_id=m.from_room_id,
            to_room_id=m.to_room_id,
            from_room_title=(rooms[m.from_room_id].title if m.from_room_id in rooms else None),
            to_room_title=(rooms[m.to_room_id].title if m.to_room_id in rooms else None),
            service_request_id=m.service_request_id,
            computer_id=m.computer_id,
            comment=m.comment,
            created_by_id=m.created_by_id,
            created_by_name=users.get(m.created_by_id) if m.created_by_id else None,
            created_at=m.created_at,
        )
        for m in rows
    ]


@router.delete("/movements/{movement_id}", status_code=204)
async def delete_movement(
    movement_id: int,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    row = await db.get(StockMovement, movement_id)
    if not row:
        raise HTTPException(status_code=404, detail="Запись истории не найдена")
    await db.delete(row)
    await db.commit()


@router.delete("/movements", status_code=200)
async def clear_movements(
    room_id: int | None = Query(default=None),
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    stmt = delete(StockMovement)
    if room_id is not None:
        stmt = stmt.where((StockMovement.from_room_id == room_id) | (StockMovement.to_room_id == room_id))
    result = await db.execute(stmt)
    await db.commit()
    return {"ok": True, "deleted": int(result.rowcount or 0)}


@router.get("/next-code")
async def get_next_code(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    return {"internal_code": await _next_internal_code(db)}


@router.get("/export.csv")
async def export_csv(
    room_id: int | None = Query(default=None),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_warehouse_db),
):
    stmt = select(StockItem).where(StockItem.status != "written_off").order_by(StockItem.id.asc())
    if room_id is not None:
        stmt = stmt.where(StockItem.room_id == room_id)
    items = (await db.execute(stmt.limit(5000))).scalars().all()
    rooms = (await db.execute(select(WarehouseRoom))).scalars().all()
    payload = render_warehouse_csv(
        [_item_out(r).model_dump() for r in items],
        preset_name={p["key"]: p["name"] for p in WAREHOUSE_PRESETS},
        preset_group={p["key"]: p["group"] for p in WAREHOUSE_PRESETS},
        room_title={r.id: r.title for r in rooms},
    )
    return Response(
        content=payload,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="corax_warehouse.csv"'},
    )


@router.post("/import.csv")
async def import_csv(
    room_id: int | None = Query(default=None),
    file: UploadFile = File(...),
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    filename = (file.filename or "").lower()
    if filename and not filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Ожидается CSV файл (.csv).")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл.")
    try:
        text = read_text_best_effort(raw)
        parsed, warnings = parse_warehouse_csv(text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    parsed = merge_consumable_rows(parsed)
    dest: WarehouseRoom | None = None
    if room_id is not None:
        dest = await db.get(WarehouseRoom, room_id)
        if not dest:
            raise HTTPException(status_code=404, detail="Помещение не найдено")
    else:
        existing_rooms = (
            await db.execute(
                select(WarehouseRoom).order_by(WarehouseRoom.sort_order.asc(), WarehouseRoom.id.asc())
            )
        ).scalars().all()
        dest = existing_rooms[-1] if existing_rooms else None
    if dest is None:
        dest = WarehouseRoom(title="Склад", sort_order=1)
        db.add(dest)
        await db.flush()

    created = 0
    updated = 0
    skipped = 0

    def _notes_with_glpi_location(notes: str | None, location: str | None) -> str | None:
        loc = (location or "").strip()
        if not loc:
            return notes
        tag = f"Местоположение GLPI: {loc}"
        if notes and tag in notes:
            return notes
        return f"{notes}\n{tag}".strip() if notes else tag

    for row in parsed:
        existing: StockItem | None = None
        if row.external_id:
            existing = await db.scalar(
                select(StockItem)
                .where(StockItem.external_id == row.external_id, StockItem.status != "written_off")
                .limit(1)
            )
        if existing is None and row.internal_code:
            existing = await db.scalar(
                select(StockItem).where(StockItem.internal_code == row.internal_code).limit(1)
            )
        if existing is not None:
            # Re-import updates attributes only — never move stock between rooms.
            existing.name = row.name
            if row.manufacturer:
                existing.manufacturer = row.manufacturer[:255]
            if row.batch_label:
                existing.batch_label = row.batch_label[:255]
            if row.notes:
                existing.notes = row.notes
            if row.serial_number:
                existing.serial_number = row.serial_number[:128]
            if row.external_id and not existing.external_id:
                existing.external_id = row.external_id
            updated += 1
            continue

        tracking = "lot"
        create_count = 1
        row_qty = row.quantity
        for i in range(create_count):
            code = row.internal_code if create_count == 1 else None
            if not code:
                code = await _next_internal_code(db)
                dup = await db.scalar(select(StockItem.id).where(StockItem.internal_code == code).limit(1))
                if dup:
                    skipped += 1
                    continue
            item = StockItem(
                room_id=dest.id,
                preset_key=row.preset_key if row.preset_key in PRESET_BY_KEY else "other",
                name=row.name,
                tracking_mode=tracking,
                quantity=row_qty,
                quantity_available=row_qty,
                internal_code=code,
                status="available",
                condition=row.condition,
                manufacturer=(row.manufacturer[:255] if row.manufacturer else None),
                external_id=row.external_id if create_count == 1 else None,
                serial_number=row.serial_number if create_count == 1 else None,
                batch_label=row.batch_label,
                notes=_notes_with_glpi_location(row.notes, row.room_title),
                created_by_id=current.id,
            )
            db.add(item)
            await db.flush()
            await _log_movement(
                db,
                item_id=item.id,
                movement_kind="receipt",
                quantity=row_qty,
                from_room_id=None,
                to_room_id=dest.id,
                created_by_id=current.id,
                comment="Импорт CSV",
                payload={"source": "csv", "index": i + 1, "of": create_count},
            )
            created += 1

    await db.commit()
    return {
        "ok": True,
        "filename": file.filename,
        "rows_in_file": len(parsed),
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "warnings": warnings,
        "merged": True,
        "room_id": dest.id,
    }


