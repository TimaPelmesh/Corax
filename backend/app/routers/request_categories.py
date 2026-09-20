from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_editor_or_superuser, get_current_user
from app.database import get_db
from app.models import ServiceRequestCategory, User
from app.request_categories_defaults import DEFAULT_REQUEST_CATEGORIES
from app.request_category_tree import (
    build_category_tree,
    category_path,
    collect_category_paths,
    insert_paths_into_session,
    tree_node_to_schema,
)
from app.schemas import RequestCategoryCreate, RequestCategoryTreeNodeOut, RequestCategoryUpdate

router = APIRouter(prefix="/request-categories", tags=["request-categories"])


async def _load_all(db: AsyncSession) -> list[ServiceRequestCategory]:
    r = await db.execute(
        select(ServiceRequestCategory).order_by(
            ServiceRequestCategory.sort_order.asc(),
            ServiceRequestCategory.name.asc(),
        )
    )
    return list(r.scalars().all())


async def _ensure_seeded(db: AsyncSession) -> None:
    cnt = int(await db.scalar(select(func.count()).select_from(ServiceRequestCategory)) or 0)
    if cnt > 0:
        return
    await insert_paths_into_session(db, DEFAULT_REQUEST_CATEGORIES)
    await db.commit()


async def _sibling_name_taken(
    db: AsyncSession,
    *,
    parent_id: int | None,
    name: str,
    exclude_id: int | None = None,
) -> bool:
    stmt = select(ServiceRequestCategory.id).where(
        ServiceRequestCategory.parent_id == parent_id,
        ServiceRequestCategory.name == name,
    )
    if exclude_id is not None:
        stmt = stmt.where(ServiceRequestCategory.id != exclude_id)
    ex = await db.scalar(stmt.limit(1))
    return ex is not None


@router.get("", response_model=list[RequestCategoryTreeNodeOut])
async def list_request_categories_tree(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _ensure_seeded(db)
    rows = await _load_all(db)
    tree = build_category_tree(rows)
    return [tree_node_to_schema(n) for n in tree]


@router.get("/paths", response_model=list[str])
async def list_request_category_paths(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _ensure_seeded(db)
    rows = await _load_all(db)
    tree = build_category_tree(rows)
    return collect_category_paths(tree)


@router.post("", response_model=RequestCategoryTreeNodeOut)
async def create_request_category(
    body: RequestCategoryCreate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Пустое название")
    parent_id = body.parent_id
    if parent_id is not None:
        parent = await db.get(ServiceRequestCategory, parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="Родительская категория не найдена")
    if await _sibling_name_taken(db, parent_id=parent_id, name=name):
        raise HTTPException(status_code=400, detail="В этой группе уже есть категория с таким названием")
    max_order = await db.scalar(
        select(func.max(ServiceRequestCategory.sort_order)).where(ServiceRequestCategory.parent_id == parent_id)
    )
    row = ServiceRequestCategory(
        name=name,
        parent_id=parent_id,
        sort_order=int(max_order or 0) + 1,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    by_id = {r.id: r for r in await _load_all(db)}
    path = category_path(row, by_id)
    return RequestCategoryTreeNodeOut(
        id=row.id,
        parent_id=row.parent_id,
        name=row.name,
        path=path,
        sort_order=row.sort_order,
        children=[],
    )


@router.patch("/{category_id}", response_model=RequestCategoryTreeNodeOut)
async def update_request_category(
    category_id: int,
    body: RequestCategoryUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    patch = body.model_dump(exclude_unset=True)
    if not patch:
        raise HTTPException(status_code=400, detail="Нет полей для обновления")
    row = await db.get(ServiceRequestCategory, category_id)
    if not row:
        raise HTTPException(status_code=404, detail="Категория не найдена")
    new_parent_id = patch["parent_id"] if "parent_id" in patch else row.parent_id
    new_name = patch.get("name", row.name).strip() if "name" in patch else row.name
    if not new_name:
        raise HTTPException(status_code=400, detail="Пустое название")
    if new_parent_id == category_id:
        raise HTTPException(status_code=400, detail="Категория не может быть родителем самой себе")
    if new_parent_id is not None:
        parent = await db.get(ServiceRequestCategory, new_parent_id)
        if not parent:
            raise HTTPException(status_code=404, detail="Родительская категория не найдена")
    if await _sibling_name_taken(db, parent_id=new_parent_id, name=new_name, exclude_id=category_id):
        raise HTTPException(status_code=400, detail="В этой группе уже есть категория с таким названием")
    if "name" in patch:
        row.name = new_name
    if "parent_id" in patch:
        row.parent_id = new_parent_id
    if "sort_order" in patch and patch["sort_order"] is not None:
        row.sort_order = int(patch["sort_order"])
    await db.commit()
    await db.refresh(row)
    by_id = {r.id: r for r in await _load_all(db)}
    return RequestCategoryTreeNodeOut(
        id=row.id,
        parent_id=row.parent_id,
        name=row.name,
        path=category_path(row, by_id),
        sort_order=row.sort_order,
        children=[],
    )


@router.delete("/{category_id}", status_code=204)
async def delete_request_category(
    category_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(ServiceRequestCategory, category_id)
    if not row:
        raise HTTPException(status_code=404, detail="Категория не найдена")
    await db.delete(row)
    await db.commit()
