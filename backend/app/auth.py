import time

from fastapi import Cookie, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
import bcrypt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from app.database import get_db
from app.jwtutil import JWTError, access_token_payload, decode_token, encode_token
from app.models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)

# Two middlewares used to SELECT the whole users row, avatar included, on every
# API call. A tab and a dialog fire several calls, so the panel waited on that
# blob before the real query. Flags stay a few seconds; token_version is part
# of the key, so logout and password change drop the cache immediately.
_GATE_TTL = 8.0
_gate_flags: dict[tuple[str, int], tuple[float, bool, bool]] = {}

PANEL_ROLES = frozenset({"observer", "editor"})


def can_access_panel(user: User) -> bool:
    if not user.is_active:
        return False
    if user.is_ldap:
        return False
    role = (getattr(user, "role", "") or "").strip().lower()
    if role == "directory":
        return False
    if role == "llm-operator":
        return True
    if user.is_superuser:
        return True
    return role in PANEL_ROLES


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(
            plain.encode("utf-8"),
            hashed.encode("utf-8"),
        )
    except (ValueError, TypeError):
        return False


def hash_password(password: str) -> str:
    return bcrypt.hashpw(
        password.encode("utf-8"),
        bcrypt.gensalt(rounds=12),
    ).decode("utf-8")


def create_access_token(subject: str, token_version: int = 0) -> str:
    return encode_token(access_token_payload(subject, token_version))


async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
    r = await db.execute(select(User).where(User.username == username))
    return r.scalar_one_or_none()


async def authenticate_user(db: AsyncSession, username: str, password: str) -> User | None:
    user = await get_user_by_username(db, username)
    if user is None:
        return None
    if not can_access_panel(user):
        return None
    if verify_password(password, user.hashed_password):
        return user
    return None


async def panel_gate_flags(username: str, token_ver: int) -> tuple[bool, bool] | None:
    """(must_change_password, is_llm_operator) or None when the token is stale.

    Does not return a User. Callers must not touch avatar_data or the password hash.
    """
    from types import SimpleNamespace

    from app.llm_access import is_llm_operator

    key = (username, int(token_ver))
    now = time.monotonic()
    hit = _gate_flags.get(key)
    if hit is not None and hit[0] > now:
        return hit[1], hit[2]
    from app.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                select(
                    User.token_version,
                    User.must_change_password,
                    User.role,
                    User.is_superuser,
                    User.is_active,
                ).where(User.username == username)
            )
        ).one_or_none()
    if row is None or int(row[0] or 0) != int(token_ver) or not row[4]:
        return None
    must_change = bool(row[1])
    operator = is_llm_operator(SimpleNamespace(is_superuser=bool(row[3]), role=row[2] or ""))
    if len(_gate_flags) > 256:
        _gate_flags.clear()
    _gate_flags[key] = (now + _GATE_TTL, must_change, operator)
    return must_change, operator


async def get_current_user(
    token: str | None = Depends(oauth2_scheme),
    access_token: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Неверный или просроченный токен",
        headers={"WWW-Authenticate": "Bearer"},
    )
    token = token or access_token
    if not token:
        raise credentials_exception
    try:
        payload = decode_token(token)
        sub: str | None = payload.get("sub")
        if sub is None:
            raise credentials_exception
        token_ver = int(payload.get("ver") or 0)
    except (JWTError, TypeError, ValueError):
        raise credentials_exception
    # avatar_data is a data-URL blob. Loading it on every API call made /me
    # and the rest of the panel wait on a fat row. /me reads the blob itself.
    loaded = await db.execute(
        select(User)
        .options(
            load_only(
                User.id,
                User.username,
                User.email,
                User.full_name,
                User.phone,
                User.avatar_emoji,
                User.avatar_bg,
                User.is_active,
                User.is_superuser,
                User.is_ldap,
                User.role,
                User.created_at,
                User.linked_directory_user_id,
                User.must_change_password,
                User.token_version,
            )
        )
        .where(User.username == sub)
    )
    user = loaded.scalar_one_or_none()
    if user is None or not user.is_active or not can_access_panel(user):
        raise credentials_exception
    if int(getattr(user, "token_version", 0) or 0) != token_ver:
        raise credentials_exception
    return user


async def get_current_user_optional(
    token: str | None = Depends(oauth2_scheme),
    access_token: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    try:
        return await get_current_user(token=token, access_token=access_token, db=db)
    except HTTPException:
        return None


async def get_current_superuser(current: User = Depends(get_current_user)) -> User:
    if not current.is_superuser:
        raise HTTPException(status_code=403, detail="Нужны права администратора")
    return current


async def verify_superuser_standalone(
    token: str | None = Depends(oauth2_scheme),
    access_token: str | None = Cookie(default=None),
) -> None:
    """Проверка админа в отдельной короткой сессии (без get_db на весь запрос).

    Нужно для операций вроде pg_restore, которые рвут активные подключения к PostgreSQL.
    """
    from app.database import AsyncSessionLocal

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Неверный или просроченный токен",
        headers={"WWW-Authenticate": "Bearer"},
    )
    tok = token or access_token
    if not tok:
        raise credentials_exception
    try:
        payload = decode_token(tok)
        sub: str | None = payload.get("sub")
        if sub is None:
            raise credentials_exception
        token_ver = int(payload.get("ver") or 0)
    except (JWTError, TypeError, ValueError):
        raise credentials_exception

    async with AsyncSessionLocal() as db:
        user = await get_user_by_username(db, sub)
        if user is None or not user.is_active:
            raise credentials_exception
        if int(getattr(user, "token_version", 0) or 0) != token_ver:
            raise credentials_exception
        if not user.is_superuser:
            raise HTTPException(status_code=403, detail="Нужны права администратора")


def _normalized_role(user: User) -> str:
    role = (getattr(user, "role", "") or "").strip().lower()
    return role if role in {"observer", "editor"} else "observer"


async def get_current_editor_or_superuser(current: User = Depends(get_current_user)) -> User:
    if current.is_superuser:
        return current
    if _normalized_role(current) == "editor":
        return current
    raise HTTPException(status_code=403, detail="Недостаточно прав: требуется роль editor или администратор")
