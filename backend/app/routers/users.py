import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_superuser, get_current_user, hash_password, verify_password
from app.database import get_db
from app.ldap_config import get_effective_ldap_config
from app.models import Computer, Monitor, User, service_request_assignees, service_request_template_assignees
from app.schemas import UserCreate, UserDirectoryItem, UserOut, UserProfilePatch, UserServiceAccountPatch

router = APIRouter(prefix="/users", tags=["users"])

PANEL_ROLES = frozenset({"observer", "editor"})


def _normalized_role(user: User) -> str:
    role = (getattr(user, "role", "") or "").strip().lower()
    if role in PANEL_ROLES or role == "directory":
        return role
    return "observer"


def _is_directory_user(user: User) -> bool:
    return bool(user.is_ldap) or _normalized_role(user) == "directory"


async def _ensure_unique_username(db: AsyncSession, username: str, exclude_id: int) -> None:
    name = username.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Логин не может быть пустым")
    r = await db.execute(
        select(User).where(func.lower(User.username) == name.lower(), User.id != exclude_id)
    )
    if r.scalar_one_or_none() is not None:
        raise HTTPException(status_code=400, detail="Пользователь с таким логином уже есть")


@router.get("", response_model=list[UserOut])
async def list_users(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(User).order_by(User.id))
    return list(r.scalars().all())


@router.post("", response_model=UserOut)
async def create_user(
    body: UserCreate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    existing_r = await db.execute(select(User).where(User.username == body.username))
    existing = existing_r.scalar_one_or_none()
    if existing is not None:
        if existing.is_ldap:
            detail = (
                "Логин уже занят: в базе есть учётная запись с тем же именем из LDAP. "
                "Она не отображалась в списке «только локальных» пользователей."
            )
        elif not existing.is_active:
            detail = (
                "Логин уже занят неактивной учётной записью. "
                "Такие записи по умолчанию скрыты в таблице — выберите другой логин или восстановите учётку."
            )
        else:
            detail = "Пользователь с таким именем уже есть"
        raise HTTPException(status_code=400, detail=detail)
    u = User(
        username=body.username,
        email=body.email,
        full_name=body.full_name,
        hashed_password=hash_password(body.password),
        is_superuser=body.is_superuser,
        role=("editor" if body.is_superuser else body.role),
        is_active=True,
        is_ldap=False,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


class UserAdminPatch(BaseModel):
    is_superuser: bool


class UserRolePatch(BaseModel):
    role: str


class ChangeMyPasswordBody(BaseModel):
    current_password: str
    new_password: str


@router.patch("/me/profile", response_model=UserOut)
async def update_my_profile(
    body: UserProfilePatch,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if _is_directory_user(current):
        raise HTTPException(status_code=403, detail="Учётная запись справочника не может входить в панель")
    if body.username is not None:
        new_name = body.username.strip()
        if new_name != current.username:
            await _ensure_unique_username(db, new_name, current.id)
            current.username = new_name
    if body.full_name is not None:
        current.full_name = body.full_name.strip() or None
    if body.email is not None:
        current.email = body.email.strip() or None
    await db.commit()
    await db.refresh(current)
    return current


@router.patch("/{user_id}", response_model=UserOut)
async def update_service_account(
    user_id: int,
    body: UserServiceAccountPatch,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    u = await db.get(User, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if _is_directory_user(u):
        raise HTTPException(
            status_code=400,
            detail="Запись справочника (LDAP/импорт) только для заявок. Создайте локальную учётку CORAX.",
        )
    if body.username is not None:
        new_name = body.username.strip()
        if new_name != u.username:
            await _ensure_unique_username(db, new_name, u.id)
            u.username = new_name
    if body.full_name is not None:
        u.full_name = body.full_name.strip() or None
    if body.email is not None:
        u.email = body.email.strip() or None
    if body.password is not None:
        pwd = body.password.strip()
        if len(pwd) < 6 or len(pwd) > 128:
            raise HTTPException(status_code=400, detail="Пароль: 6..128 символов")
        u.hashed_password = hash_password(pwd)
    await db.commit()
    await db.refresh(u)
    return u


@router.patch("/{user_id}/admin", response_model=UserOut)
async def set_user_admin(
    user_id: int,
    body: UserAdminPatch,
    current: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    u = await db.get(User, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if _is_directory_user(u):
        raise HTTPException(status_code=400, detail="Нельзя назначить администратором запись справочника")
    if u.id == current.id and not body.is_superuser:
        raise HTTPException(status_code=400, detail="Нельзя снять права администратора у самого себя")
    u.is_superuser = bool(body.is_superuser)
    if u.is_superuser:
        u.role = "editor"
    await db.commit()
    await db.refresh(u)
    return u


@router.patch("/{user_id}/role", response_model=UserOut)
async def set_user_role(
    user_id: int,
    body: UserRolePatch,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    role = (body.role or "").strip().lower()
    if role not in {"observer", "editor"}:
        raise HTTPException(status_code=400, detail="Роль должна быть observer или editor")
    u = await db.get(User, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if _is_directory_user(u):
        raise HTTPException(status_code=400, detail="Роль справочника заявок не меняется — создайте учётку CORAX")
    if u.is_superuser:
        raise HTTPException(status_code=400, detail="Для администратора роль фиксирована")
    u.role = role
    await db.commit()
    await db.refresh(u)
    return u


@router.post("/me/change-password")
async def change_my_password(
    body: ChangeMyPasswordBody,
    current: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if _is_directory_user(current):
        raise HTTPException(status_code=403, detail="Учётная запись справочника не может менять пароль панели")
    u = await db.get(User, current.id)
    if u is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    new_password = (body.new_password or "").strip()
    if len(new_password) < 6 or len(new_password) > 128:
        raise HTTPException(status_code=400, detail="Новый пароль: 6..128 символов")
    if not verify_password(body.current_password or "", u.hashed_password):
        raise HTTPException(status_code=400, detail="Текущий пароль неверный")
    u.hashed_password = hash_password(new_password)
    await db.commit()
    return {"ok": True}


@router.post("/{user_id}/delete")
async def delete_user(
    user_id: int,
    current: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """
    "Удаление" пользователя без поломки ссылок: деактивирует учётку и очищает привязки.
    Заявки/шаблоны, созданные пользователем (created_by_id), сохраняются в истории.
    """
    u = await db.get(User, user_id)
    if u is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if u.id == current.id:
        raise HTTPException(status_code=400, detail="Нельзя удалить самого себя")

    # 1) Снять роль и деактивировать.
    u.is_superuser = False
    u.role = "observer"
    u.is_active = False

    # 2) Очистить привязки (где возможно) и связи many-to-many.
    await db.execute(update(Computer).where(Computer.assigned_user_id == user_id).values(assigned_user_id=None))
    await db.execute(update(Monitor).where(Monitor.assigned_user_id == user_id).values(assigned_user_id=None))
    await db.execute(delete(service_request_assignees).where(service_request_assignees.c.user_id == user_id))
    await db.execute(delete(service_request_template_assignees).where(service_request_template_assignees.c.user_id == user_id))

    await db.commit()
    return {"ok": True}


@router.get("/directory", response_model=list[UserDirectoryItem])
async def users_directory(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Справочник для ответственных и инициатора: все активные учётки в БД (локальные и импорт из LDAP).
    r = await db.execute(
        select(User.id, User.username, User.full_name)
        .where(User.is_active == True)  # noqa: E712
        .order_by(User.username.asc())
    )
    return [UserDirectoryItem(id=int(row[0]), username=str(row[1]), full_name=row[2]) for row in r.all()]


@router.get("/admin/ldap/status")
async def ldap_status(_: User = Depends(get_current_superuser), db: AsyncSession = Depends(get_db)):
    eff, _ = await get_effective_ldap_config(db)
    return {"configured": eff.configured}


@router.post("/admin/ldap/sync")
async def ldap_sync(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    eff, _ = await get_effective_ldap_config(db)
    if not eff.configured:
        raise HTTPException(
            status_code=400,
            detail="LDAP не настроен: откройте Настройки → LDAP и заполните параметры подключения",
        )

    try:
        from ldap3 import Connection, Server
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Модуль ldap3 не установлен. Установите зависимости backend.",
        ) from exc

    def _attr_value(entry, attr_name: str) -> str | None:
        if attr_name in entry:
            v = entry[attr_name].value
            if isinstance(v, list):
                v = v[0] if v else None
            if v is None:
                return None
            s = str(v).strip()
            return s or None
        return None

    # get_info=ALL can be very slow on some AD setups; bind/search does not require it.
    server = Server(eff.uri)
    try:
        if eff.allow_anonymous:
            conn_ctx = Connection(server, auto_bind=True)
        else:
            conn_ctx = Connection(server, user=eff.bind_dn, password=eff.bind_password, auto_bind=True)
        with conn_ctx as conn:
            attrs = list(
                {
                    eff.username_attr,
                    eff.display_name_attr,
                    eff.email_attr,
                }
            )
            conn.search(
                search_base=eff.user_search_base,
                search_filter=eff.user_filter,
                attributes=attrs,
                size_limit=max(1, int(eff.sync_limit)),
            )
            ldap_entries = conn.entries
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ошибка LDAP: {exc}") from exc

    created_count = 0
    skipped_count = 0
    scanned_count = len(ldap_entries)
    missing_username_attr = 0
    result_entries: list[dict] = []

    existing_rows = (
        await db.execute(select(User).where(User.is_active.is_(True)))
    ).scalars().all()
    existing_by_name: dict[str, User] = {
        u.username.strip().lower(): u for u in existing_rows if u.username
    }

    for e in ldap_entries:
        username_raw = _attr_value(e, eff.username_attr)
        if not username_raw:
            missing_username_attr += 1
            continue
        username = username_raw.strip()
        username_key = username.lower()
        full_name = _attr_value(e, eff.display_name_attr)
        email = _attr_value(e, eff.email_attr)
        existing = existing_by_name.get(username_key)
        if existing is not None:
            if full_name and existing.full_name != full_name:
                existing.full_name = full_name
            if email and existing.email != email:
                existing.email = email
            if not existing.is_ldap:
                existing.is_ldap = True
            existing.role = "directory"
            existing.is_superuser = False
            skipped_count += 1
            result_entries.append({"username": username, "created": False, "one_time_password": None})
            continue

        one_time_password = secrets.token_urlsafe(9)
        user = User(
            username=username,
            email=email,
            full_name=full_name,
            hashed_password=hash_password(one_time_password),
            is_superuser=False,
            role="directory",
            is_active=True,
            is_ldap=True,
        )
        db.add(user)
        existing_by_name[username_key] = user
        created_count += 1
        result_entries.append(
            {"username": username, "created": True, "one_time_password": one_time_password}
        )

    await db.commit()
    # Keep backward compatible keys, add diagnostics for UI.
    return {
        "created_count": created_count,
        "skipped_count": skipped_count,
        "entries": result_entries,
        "scanned_count": scanned_count,
        "missing_username_attr": missing_username_attr,
    }
