from __future__ import annotations

import json
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import can_access_panel, get_current_user
from app.database import get_db
from app.models import CalendarDayMark, User
from app.schemas import (
    CalendarMarkCreate,
    CalendarMarkOut,
    CalendarMarkUpdate,
    CalendarMarkVisibility,
)

router = APIRouter(prefix="/calendar-marks", tags=["calendar-marks"])

_KINDS = frozenset({"weekend", "holiday", "payday"})
_VIS = frozenset({"private", "shared", "org"})


def _validate_range(start: date, end: date) -> None:
    if end < start:
        raise HTTPException(status_code=400, detail="Дата окончания раньше начала")
    if (end - start).days > 366 * 3:
        raise HTTPException(status_code=400, detail="Диапазон длиннее трёх лет")


def _can_set_visibility(user: User, visibility: CalendarMarkVisibility) -> None:
    if visibility == "org" and not user.is_superuser:
        raise HTTPException(status_code=403, detail="Общие для панели может задавать только админ")


def _visible_filter(user: User):
    return or_(
        CalendarDayMark.owner_user_id == user.id,
        CalendarDayMark.visibility.in_(("shared", "org")),
    )


def _encode_weekdays(days: list[int] | None) -> str:
    if not days:
        return ""
    cleaned = sorted({int(d) for d in days if isinstance(d, int) and 0 <= int(d) <= 6})
    if not cleaned:
        return ""
    return ",".join(str(d) for d in cleaned)


def _decode_weekdays(raw: str | None) -> list[int]:
    if not raw or not str(raw).strip():
        return []
    out: list[int] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part)
        except ValueError:
            continue
        if 0 <= value <= 6:
            out.append(value)
    return sorted(set(out))


def _encode_month_days(days: list[int] | None) -> str:
    if not days:
        return ""
    cleaned = sorted({int(d) for d in days if isinstance(d, int) and 1 <= int(d) <= 31})
    if not cleaned:
        return ""
    return ",".join(str(d) for d in cleaned)


def _decode_month_days(raw: str | None) -> list[int]:
    if not raw or not str(raw).strip():
        return []
    out: list[int] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part)
        except ValueError:
            continue
        if 1 <= value <= 31:
            out.append(value)
    return sorted(set(out))


def _encode_exceptions(days: list[date] | None) -> str:
    if not days:
        return "[]"
    uniq = sorted({d.isoformat() for d in days})
    return json.dumps(uniq, ensure_ascii=False)


def _decode_exceptions(raw: str | None) -> list[date]:
    if not raw or not str(raw).strip():
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[date] = []
    for item in data:
        text = str(item).strip()
        if not text:
            continue
        try:
            out.append(date.fromisoformat(text[:10]))
        except ValueError:
            continue
    return sorted(set(out))


def _mark_out(mark: CalendarDayMark, owner: User | None, viewer: User) -> CalendarMarkOut:
    mine = mark.owner_user_id == viewer.id
    can_edit = mine or (viewer.is_superuser and mark.visibility == "org")
    return CalendarMarkOut(
        id=mark.id,
        kind=mark.kind,  # type: ignore[arg-type]
        title=mark.title or "",
        color=getattr(mark, "color", None),  # type: ignore[arg-type]
        start_date=mark.start_date,
        end_date=mark.end_date,
        visibility=mark.visibility,  # type: ignore[arg-type]
        weekdays=_decode_weekdays(getattr(mark, "weekdays", "")),
        month_days=_decode_month_days(getattr(mark, "month_days", "")),
        exceptions=_decode_exceptions(getattr(mark, "exceptions_json", "[]")),
        owner_user_id=mark.owner_user_id,
        owner_username=owner.username if owner else None,
        owner_full_name=owner.full_name if owner else None,
        mine=mine,
        can_edit=can_edit,
        created_at=mark.created_at,
        updated_at=mark.updated_at,
    )


@router.get("", response_model=list[CalendarMarkOut])
async def list_marks(
    from_date: date = Query(..., alias="from"),
    to_date: date = Query(..., alias="to"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not can_access_panel(user):
        raise HTTPException(status_code=403, detail="Нет доступа")
    if to_date < from_date:
        raise HTTPException(status_code=400, detail="Неверный период")

    rows = (
        await db.execute(
            select(CalendarDayMark, User)
            .outerjoin(User, User.id == CalendarDayMark.owner_user_id)
            .where(
                _visible_filter(user),
                CalendarDayMark.start_date <= to_date,
                CalendarDayMark.end_date >= from_date,
            )
            .order_by(CalendarDayMark.start_date.asc(), CalendarDayMark.id.asc())
        )
    ).all()
    return [_mark_out(mark, owner, user) for mark, owner in rows]


@router.post("", response_model=CalendarMarkOut)
async def create_mark(
    body: CalendarMarkCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not can_access_panel(user):
        raise HTTPException(status_code=403, detail="Нет доступа")
    if body.kind not in _KINDS:
        raise HTTPException(status_code=400, detail="Неверный тип")
    if body.visibility not in _VIS:
        raise HTTPException(status_code=400, detail="Неверная видимость")
    _can_set_visibility(user, body.visibility)
    _validate_range(body.start_date, body.end_date)

    mark = CalendarDayMark(
        kind=body.kind,
        title=(body.title or "").strip()[:255],
        color=body.color,
        start_date=body.start_date,
        end_date=body.end_date,
        visibility=body.visibility,
        weekdays=_encode_weekdays([] if body.month_days else body.weekdays),
        month_days=_encode_month_days(body.month_days),
        exceptions_json=_encode_exceptions(body.exceptions),
        owner_user_id=user.id,
    )
    db.add(mark)
    await db.commit()
    await db.refresh(mark)
    return _mark_out(mark, user, user)


@router.patch("/{mark_id}", response_model=CalendarMarkOut)
async def update_mark(
    mark_id: int,
    body: CalendarMarkUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not can_access_panel(user):
        raise HTTPException(status_code=403, detail="Нет доступа")
    mark = await db.get(CalendarDayMark, mark_id)
    if mark is None:
        raise HTTPException(status_code=404, detail="Период не найден")
    mine = mark.owner_user_id == user.id
    if not mine and not (user.is_superuser and mark.visibility == "org"):
        raise HTTPException(status_code=403, detail="Нет прав")

    patch = body.model_dump(exclude_unset=True)
    if "kind" in patch and patch["kind"] not in _KINDS:
        raise HTTPException(status_code=400, detail="Неверный тип")
    if "visibility" in patch:
        if patch["visibility"] not in _VIS:
            raise HTTPException(status_code=400, detail="Неверная видимость")
        _can_set_visibility(user, patch["visibility"])
    start = patch.get("start_date", mark.start_date)
    end = patch.get("end_date", mark.end_date)
    _validate_range(start, end)

    if "kind" in patch:
        mark.kind = patch["kind"]
    if "title" in patch and patch["title"] is not None:
        mark.title = str(patch["title"]).strip()[:255]
    if "color" in patch:
        mark.color = patch["color"]
    if "start_date" in patch:
        mark.start_date = patch["start_date"]
    if "end_date" in patch:
        mark.end_date = patch["end_date"]
    if "visibility" in patch:
        mark.visibility = patch["visibility"]
    if "weekdays" in patch:
        mark.weekdays = _encode_weekdays(patch["weekdays"])
    if "month_days" in patch:
        mark.month_days = _encode_month_days(patch["month_days"])
        if patch["month_days"]:
            mark.weekdays = ""
    if "exceptions" in patch:
        mark.exceptions_json = _encode_exceptions(patch["exceptions"])
    mark.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(mark)
    owner = await db.get(User, mark.owner_user_id)
    return _mark_out(mark, owner, user)


@router.delete("/{mark_id}")
async def delete_mark(
    mark_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not can_access_panel(user):
        raise HTTPException(status_code=403, detail="Нет доступа")
    mark = await db.get(CalendarDayMark, mark_id)
    if mark is None:
        raise HTTPException(status_code=404, detail="Период не найден")
    mine = mark.owner_user_id == user.id
    if not mine and not (user.is_superuser and mark.visibility == "org"):
        raise HTTPException(status_code=403, detail="Нет прав")
    await db.delete(mark)
    await db.commit()
    return {"ok": True}
