from __future__ import annotations

import json
import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_editor_or_superuser, get_current_user
from app.database import get_warehouse_db
from app.models import User
from app.warehouse_models import StockItem, StockMovement, WarehouseRoom

router = APIRouter(prefix="/warehouse", tags=["warehouse"])

WAREHOUSE_PRESETS: list[dict[str, str]] = [
    {"key": "ram", "name": "ОЗУ", "group": "components", "default_tracking": "lot"},
    {"key": "ssd", "name": "SSD", "group": "components", "default_tracking": "unit"},
    {"key": "hdd", "name": "HDD", "group": "components", "default_tracking": "unit"},
    {"key": "cpu", "name": "Процессор", "group": "components", "default_tracking": "unit"},
    {"key": "gpu", "name": "Видеокарта", "group": "components", "default_tracking": "unit"},
    {"key": "motherboard", "name": "Материнская плата", "group": "components", "default_tracking": "unit"},
    {"key": "psu", "name": "Блок питания", "group": "components", "default_tracking": "unit"},
    {"key": "case", "name": "Корпус", "group": "components", "default_tracking": "unit"},
    {"key": "switch", "name": "Коммутатор", "group": "network", "default_tracking": "unit"},
    {"key": "ap", "name": "Точка доступа", "group": "network", "default_tracking": "unit"},
    {"key": "router", "name": "Маршрутизатор", "group": "network", "default_tracking": "unit"},
    {"key": "patch_cord", "name": "Патч-корд / кабель", "group": "network", "default_tracking": "lot"},
    {"key": "monitor", "name": "Монитор", "group": "other", "default_tracking": "unit"},
    {"key": "peripheral", "name": "Периферия", "group": "other", "default_tracking": "lot"},
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
    serial_number: str | None = Field(default=None, max_length=128)
    batch_label: str | None = Field(default=None, max_length=255)
    attributes_json: str | None = None
    notes: str | None = None
    auto_code: bool = False


class StockItemPatch(BaseModel):
    name: str | None = Field(default=None, max_length=512)
    quantity: int | None = Field(default=None, ge=1, le=9999)
    condition: str | None = Field(default=None, pattern="^(new|used|defective)$")
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
    movement_kind: str
    quantity: int
    from_room_id: int | None
    to_room_id: int | None
    service_request_id: int | None
    computer_id: int | None
    comment: str | None
    created_by_id: int | None
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
        select(StockItem.room_id, func.count())
        .where(StockItem.room_id.in_(room_ids), StockItem.status != "written_off")
        .group_by(StockItem.room_id)
    )
    return {int(room_id): int(cnt) for room_id, cnt in r.all()}


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
    if live and live > 0:
        raise HTTPException(
            status_code=409,
            detail="Нельзя удалить помещение с позициями на складе — сначала перенесите или спишите их",
        )
    total_rooms = await db.scalar(select(func.count()).select_from(WarehouseRoom))
    if total_rooms and total_rooms <= 1:
        raise HTTPException(status_code=409, detail="Нельзя удалить единственное складское помещение")

    # Write-offs stay in DB with room_id (FK RESTRICT) but are hidden from UI counts.
    # Purge them (and their movements) so an "empty" room can be deleted.
    written_off_ids = (
        await db.execute(
            select(StockItem.id).where(StockItem.room_id == room_id, StockItem.status == "written_off")
        )
    ).scalars().all()
    if written_off_ids:
        await db.execute(delete(StockMovement).where(StockMovement.item_id.in_(written_off_ids)))
        await db.execute(delete(StockItem).where(StockItem.id.in_(written_off_ids)))

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
            | func.lower(func.coalesce(StockItem.batch_label, "")).like(needle)
            | func.lower(func.coalesce(StockItem.notes, "")).like(needle)
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
    tracking = body.tracking_mode
    if preset_key in PRESET_BY_KEY:
        tracking = body.tracking_mode or PRESET_BY_KEY[preset_key]["default_tracking"]
    qty = 1 if tracking == "unit" else body.quantity
    internal_code = (body.internal_code or "").strip() or None
    if tracking == "unit" and body.auto_code and not internal_code:
        internal_code = await _next_internal_code(db)
    if internal_code:
        dup = await db.scalar(select(StockItem.id).where(StockItem.internal_code == internal_code).limit(1))
        if dup:
            raise HTTPException(status_code=409, detail=f"Код {internal_code} уже используется")
    row = StockItem(
        room_id=body.room_id,
        preset_key=preset_key,
        name=body.name.strip(),
        tracking_mode=tracking,
        quantity=qty,
        quantity_available=qty,
        internal_code=internal_code,
        status="available",
        condition=body.condition,
        serial_number=(body.serial_number or "").strip() or None,
        batch_label=(body.batch_label or "").strip() or None,
        attributes_json=body.attributes_json,
        notes=(body.notes or "").strip() or None,
        created_by_id=current.id,
    )
    db.add(row)
    await db.flush()
    await _log_movement(
        db,
        item_id=row.id,
        movement_kind="receipt",
        quantity=qty,
        from_room_id=None,
        to_room_id=body.room_id,
        created_by_id=current.id,
        comment="Приход на склад",
        payload={"preset_key": preset_key, "name": row.name},
    )
    await db.commit()
    await db.refresh(row)
    return _item_out(row)


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
    old_qty = row.quantity
    if body.name is not None:
        t = body.name.strip()
        if t:
            row.name = t
    if body.quantity is not None and row.tracking_mode == "lot":
        row.quantity = body.quantity
        row.quantity_available = body.quantity
    if body.condition is not None:
        row.condition = body.condition
    if body.serial_number is not None:
        row.serial_number = body.serial_number.strip() or None
    if body.batch_label is not None:
        row.batch_label = body.batch_label.strip() or None
    if body.attributes_json is not None:
        row.attributes_json = body.attributes_json
    if body.notes is not None:
        row.notes = body.notes.strip() or None
    if body.quantity is not None and row.tracking_mode == "lot" and body.quantity != old_qty:
        await _log_movement(
            db,
            item_id=row.id,
            movement_kind="adjust",
            quantity=body.quantity,
            from_room_id=row.room_id,
            to_room_id=row.room_id,
            created_by_id=current.id,
            comment="Корректировка количества",
            payload={"old_quantity": old_qty, "new_quantity": body.quantity},
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
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    row = await db.get(StockItem, item_id)
    if not row:
        raise HTTPException(status_code=404, detail="Позиция не найдена")
    if row.status == "written_off":
        raise HTTPException(status_code=409, detail="Уже списано")
    row.status = "written_off"
    row.quantity_available = 0
    await _log_movement(
        db,
        item_id=row.id,
        movement_kind="write_off",
        quantity=row.quantity,
        from_room_id=row.room_id,
        to_room_id=None,
        created_by_id=current.id,
        comment=(comment or "").strip() or "Списание",
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
):
    stmt = select(StockMovement).order_by(StockMovement.created_at.desc(), StockMovement.id.desc())
    if item_id is not None:
        stmt = stmt.where(StockMovement.item_id == item_id)
    elif room_id is not None:
        stmt = stmt.where((StockMovement.from_room_id == room_id) | (StockMovement.to_room_id == room_id))
    rows = (await db.execute(stmt.limit(limit))).scalars().all()
    return [
        StockMovementOut(
            id=m.id,
            item_id=m.item_id,
            movement_kind=m.movement_kind,
            quantity=m.quantity,
            from_room_id=m.from_room_id,
            to_room_id=m.to_room_id,
            service_request_id=m.service_request_id,
            computer_id=m.computer_id,
            comment=m.comment,
            created_by_id=m.created_by_id,
            created_at=m.created_at,
        )
        for m in rows
    ]


@router.get("/next-code")
async def get_next_code(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_warehouse_db),
):
    return {"internal_code": await _next_internal_code(db)}


async def ensure_default_warehouse_room(db: AsyncSession) -> None:
    cnt = await db.scalar(select(func.count()).select_from(WarehouseRoom))
    if not cnt:
        db.add(WarehouseRoom(title="Склад ИТ", sort_order=1, notes="Помещение по умолчанию"))
        await db.commit()
