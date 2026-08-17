from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import can_access_panel, get_current_user
from app.database import get_db
from app.models import Note, NoteShare, User
from app.schemas import (
    NoteCreate,
    NoteListItem,
    NoteOut,
    NoteShareOut,
    NoteSharesReplace,
    NoteUpdate,
)

router = APIRouter(prefix="/notes", tags=["notes"])

_BODY_MAX = 500_000


async def _load_note(db: AsyncSession, note_id: int) -> Note:
    note = await db.get(Note, note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Заметка не найдена")
    return note


async def _access(db: AsyncSession, note: Note, user: User) -> tuple[bool, bool]:
    """Returns (can_view, can_edit). Superuser can view/edit everything."""
    if user.is_superuser:
        return True, True
    if note.owner_user_id == user.id:
        return True, True
    share = (
        await db.execute(
            select(NoteShare).where(NoteShare.note_id == note.id, NoteShare.user_id == user.id)
        )
    ).scalar_one_or_none()
    if share is None:
        return False, False
    return True, bool(share.can_edit)


async def _shares_out(db: AsyncSession, note_id: int) -> list[NoteShareOut]:
    rows = (
        await db.execute(
            select(NoteShare, User)
            .join(User, User.id == NoteShare.user_id)
            .where(NoteShare.note_id == note_id)
            .order_by(User.username.asc())
        )
    ).all()
    return [
        NoteShareOut(
            user_id=u.id,
            username=u.username,
            full_name=u.full_name,
            can_edit=bool(s.can_edit),
        )
        for s, u in rows
    ]


async def _note_out(db: AsyncSession, note: Note, viewer: User) -> NoteOut:
    can_view, can_edit = await _access(db, note, viewer)
    if not can_view:
        raise HTTPException(status_code=404, detail="Заметка не найдена")
    owner = await db.get(User, note.owner_user_id)
    return NoteOut(
        id=note.id,
        title=note.title or "",
        body_html=note.body_html or "",
        owner_user_id=note.owner_user_id,
        owner_username=owner.username if owner else None,
        owner_full_name=owner.full_name if owner else None,
        plan_start=note.plan_start,
        plan_end=note.plan_end,
        created_at=note.created_at,
        updated_at=note.updated_at,
        can_edit=can_edit,
        is_owner=note.owner_user_id == viewer.id or bool(viewer.is_superuser),
        shares=await _shares_out(db, note.id),
    )


def _validate_plan_dates(plan_start: date | None, plan_end: date | None) -> None:
    if plan_start and plan_end and plan_end < plan_start:
        raise HTTPException(status_code=400, detail="Дата окончания раньше начала")


@router.get("", response_model=list[NoteListItem])
async def list_notes(
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if current.is_superuser:
        q = select(Note).order_by(Note.updated_at.desc())
    else:
        shared_ids = (
            select(NoteShare.note_id).where(NoteShare.user_id == current.id)
        )
        q = (
            select(Note)
            .where(or_(Note.owner_user_id == current.id, Note.id.in_(shared_ids)))
            .order_by(Note.updated_at.desc())
        )
    notes = list((await db.execute(q)).scalars().all())
    if not notes:
        return []

    owner_ids = {n.owner_user_id for n in notes}
    owners = {
        u.id: u
        for u in (
            await db.execute(select(User).where(User.id.in_(owner_ids)))
        ).scalars().all()
    }
    my_shares = {
        s.note_id: s
        for s in (
            await db.execute(
                select(NoteShare).where(
                    NoteShare.user_id == current.id,
                    NoteShare.note_id.in_([n.id for n in notes]),
                )
            )
        ).scalars().all()
    }

    out: list[NoteListItem] = []
    for n in notes:
        is_owner = n.owner_user_id == current.id or bool(current.is_superuser)
        share = my_shares.get(n.id)
        can_edit = is_owner or (share is not None and bool(share.can_edit))
        owner = owners.get(n.owner_user_id)
        out.append(
            NoteListItem(
                id=n.id,
                title=n.title or "",
                owner_user_id=n.owner_user_id,
                owner_username=owner.username if owner else None,
                plan_start=n.plan_start,
                plan_end=n.plan_end,
                updated_at=n.updated_at,
                can_edit=can_edit,
                is_owner=is_owner,
                is_shared_with_me=share is not None and n.owner_user_id != current.id,
            )
        )
    return out


@router.post("", response_model=NoteOut)
async def create_note(
    body: NoteCreate,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _validate_plan_dates(body.plan_start, body.plan_end)
    html = (body.body_html or "")[:_BODY_MAX]
    note = Note(
        title=(body.title or "").strip() or "Без названия",
        body_html=html,
        owner_user_id=current.id,
        plan_start=body.plan_start,
        plan_end=body.plan_end,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return await _note_out(db, note, current)


@router.get("/{note_id}", response_model=NoteOut)
async def get_note(
    note_id: int,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    note = await _load_note(db, note_id)
    return await _note_out(db, note, current)


@router.patch("/{note_id}", response_model=NoteOut)
async def update_note(
    note_id: int,
    body: NoteUpdate,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    note = await _load_note(db, note_id)
    can_view, can_edit = await _access(db, note, current)
    if not can_view:
        raise HTTPException(status_code=404, detail="Заметка не найдена")
    if not can_edit:
        raise HTTPException(status_code=403, detail="Нет прав на редактирование")

    patch = body.model_dump(exclude_unset=True)
    if "title" in patch and patch["title"] is not None:
        note.title = (patch["title"] or "").strip() or "Без названия"
    if "body_html" in patch and patch["body_html"] is not None:
        note.body_html = (patch["body_html"] or "")[:_BODY_MAX]
    if "plan_start" in patch:
        note.plan_start = patch["plan_start"]
    if "plan_end" in patch:
        note.plan_end = patch["plan_end"]
    _validate_plan_dates(note.plan_start, note.plan_end)
    note.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(note)
    return await _note_out(db, note, current)


@router.delete("/{note_id}")
async def delete_note(
    note_id: int,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    note = await _load_note(db, note_id)
    if note.owner_user_id != current.id and not current.is_superuser:
        raise HTTPException(status_code=403, detail="Удалить может только автор")
    await db.delete(note)
    await db.commit()
    return {"ok": True}


@router.put("/{note_id}/shares", response_model=NoteOut)
async def replace_shares(
    note_id: int,
    body: NoteSharesReplace,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    note = await _load_note(db, note_id)
    if note.owner_user_id != current.id and not current.is_superuser:
        raise HTTPException(status_code=403, detail="Доступом управляет только автор")

    seen: set[int] = set()
    cleaned: list[tuple[int, bool]] = []
    for item in body.shares:
        uid = int(item.user_id)
        if uid in seen or uid == note.owner_user_id:
            continue
        seen.add(uid)
        target = await db.get(User, uid)
        if target is None or not can_access_panel(target):
            raise HTTPException(
                status_code=400,
                detail=f"Пользователь id={uid} недоступен для шаринга (нужна учётка панели)",
            )
        cleaned.append((uid, bool(item.can_edit)))

    await db.execute(delete(NoteShare).where(NoteShare.note_id == note.id))
    for uid, can_edit in cleaned:
        db.add(NoteShare(note_id=note.id, user_id=uid, can_edit=can_edit))
    note.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(note)
    return await _note_out(db, note, current)


async def accessible_notes_count(db: AsyncSession, user: User) -> int:
    """How many notes the user can see (same scope as list_notes)."""
    if user.is_superuser:
        return int(await db.scalar(select(func.count()).select_from(Note)) or 0)
    shared_ids = select(NoteShare.note_id).where(NoteShare.user_id == user.id)
    return int(
        await db.scalar(
            select(func.count())
            .select_from(Note)
            .where(or_(Note.owner_user_id == user.id, Note.id.in_(shared_ids)))
        )
        or 0
    )


async def accessible_upcoming_notes(
    db: AsyncSession,
    user: User,
    *,
    horizon_days: int = 30,
    limit: int = 8,
) -> list[tuple[Note, User | None]]:
    """Dated plans in window, then recent notes — for dashboard."""
    today = date.today()
    from datetime import timedelta

    horizon = today + timedelta(days=horizon_days)

    if user.is_superuser:
        access_filter = True
    else:
        shared_ids = select(NoteShare.note_id).where(NoteShare.user_id == user.id)
        access_filter = or_(Note.owner_user_id == user.id, Note.id.in_(shared_ids))

    has_plan = or_(Note.plan_start.is_not(None), Note.plan_end.is_not(None))
    in_window = and_(
        has_plan,
        or_(
            and_(
                Note.plan_start.is_not(None),
                Note.plan_start <= horizon,
                or_(Note.plan_end.is_(None), Note.plan_end >= today),
            ),
            and_(
                Note.plan_start.is_(None),
                Note.plan_end.is_not(None),
                Note.plan_end >= today,
                Note.plan_end <= horizon,
            ),
        ),
    )

    q_dated = select(Note).where(in_window)
    if access_filter is not True:
        q_dated = q_dated.where(access_filter)
    q_dated = q_dated.order_by(
        Note.plan_start.asc().nulls_last(),
        Note.plan_end.asc().nulls_last(),
        Note.updated_at.desc(),
    ).limit(limit)

    dated = list((await db.execute(q_dated)).scalars().all())
    seen = {n.id for n in dated}
    notes = list(dated)

    if len(notes) < limit:
        q_recent = select(Note).order_by(Note.updated_at.desc()).limit(limit * 3)
        if access_filter is not True:
            q_recent = q_recent.where(access_filter)
        for n in (await db.execute(q_recent)).scalars().all():
            if n.id in seen:
                continue
            notes.append(n)
            seen.add(n.id)
            if len(notes) >= limit:
                break

    if not notes:
        return []
    owners = {
        u.id: u
        for u in (
            await db.execute(select(User).where(User.id.in_({n.owner_user_id for n in notes})))
        ).scalars().all()
    }
    return [(n, owners.get(n.owner_user_id)) for n in notes]
