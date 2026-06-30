from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import WarehouseBase


class WarehouseRoom(WarehouseBase):
    """Складское помещение (аналог этажа на карте здания)."""

    __tablename__ = "warehouse_rooms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), default="Склад", index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StockItem(WarehouseBase):
    """Позиция на складе: поштучно (unit) или партией (lot)."""

    __tablename__ = "stock_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("warehouse_rooms.id", ondelete="RESTRICT"), index=True)
    preset_key: Mapped[str] = mapped_column(String(32), default="custom", index=True)
    name: Mapped[str] = mapped_column(String(512))
    tracking_mode: Mapped[str] = mapped_column(String(16), default="lot")  # unit | lot
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    quantity_available: Mapped[int] = mapped_column(Integer, default=1)
    internal_code: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(32), default="available", index=True)
    condition: Mapped[str] = mapped_column(String(32), default="new")  # new | used | defective
    serial_number: Mapped[str | None] = mapped_column(String(128), nullable=True)
    batch_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attributes_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StockMovement(WarehouseBase):
    """Журнал движений (append-only)."""

    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("stock_items.id", ondelete="CASCADE"), index=True)
    movement_kind: Mapped[str] = mapped_column(String(32), index=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    from_room_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    to_room_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    service_request_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    computer_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
