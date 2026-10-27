from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, get_current_editor_or_superuser
from app.database import get_db
from app.models import Tag, User
from app.schemas import TagCreate, TagOut, TagUpdate

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("", response_model=list[TagOut])
async def list_tags(_: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(Tag).order_by(Tag.name.asc()))
    return list(r.scalars().all())


@router.post("", response_model=TagOut)
async def create_tag(
    body: TagCreate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Пустое имя тега")
    ex = await db.execute(select(Tag.id).where(Tag.name == name))
    if ex.scalar_one_or_none() is not None:
        raise HTTPException(status_code=400, detail="Такой тег уже есть")
    t = Tag(name=name, color=body.color)
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return t


@router.patch("/{tag_id}", response_model=TagOut)
async def update_tag(
    tag_id: int,
    body: TagUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    patch = body.model_dump(exclude_unset=True)
    if not patch:
        raise HTTPException(status_code=400, detail="Нет полей для обновления")
    r = await db.execute(select(Tag).where(Tag.id == tag_id))
    t = r.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Тег не найден")
    if "name" in patch:
        new_name = patch["name"].strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Пустое имя тега")
        ex = await db.execute(select(Tag.id).where(Tag.name == new_name, Tag.id != tag_id))
        if ex.scalar_one_or_none() is not None:
            raise HTTPException(status_code=400, detail="Такой тег уже есть")
        t.name = new_name
    if "color" in patch:
        t.color = patch["color"]
    await db.commit()
    await db.refresh(t)
    return t


@router.delete("/{tag_id}", status_code=204)
async def delete_tag(
    tag_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(Tag.id).where(Tag.id == tag_id))
    if r.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Тег не найден")
    await db.execute(delete(Tag).where(Tag.id == tag_id))
    await db.commit()
