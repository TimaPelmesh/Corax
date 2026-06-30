from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Cookie, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.ldap_auth import authenticate_via_ldap
from app.ldap_config import get_effective_ldap_config
from app.models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


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


def create_access_token(subject: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {"sub": subject, "exp": expire},
        settings.secret_key,
        algorithm=settings.algorithm,
    )


async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
    r = await db.execute(select(User).where(User.username == username))
    return r.scalar_one_or_none()


async def authenticate_user(db: AsyncSession, username: str, password: str) -> User | None:
    user = await get_user_by_username(db, username)
    if user and verify_password(password, user.hashed_password):
        return user

    # Fallback to LDAP if enabled/configured.
    try:
        cfg, _ = await get_effective_ldap_config(db)
        ldap_user = await authenticate_via_ldap(db, cfg, username, password)
        if ldap_user:
            return ldap_user
    except Exception:
        # Do not break local auth due to LDAP issues.
        pass
    return None


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
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        sub: str | None = payload.get("sub")
        if sub is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    user = await get_user_by_username(db, sub)
    if user is None or not user.is_active:
        raise credentials_exception
    return user


async def get_current_superuser(current: User = Depends(get_current_user)) -> User:
    if not current.is_superuser:
        raise HTTPException(status_code=403, detail="Нужны права администратора")
    return current


def _normalized_role(user: User) -> str:
    role = (getattr(user, "role", "") or "").strip().lower()
    return role if role in {"observer", "editor"} else "observer"


async def get_current_editor_or_superuser(current: User = Depends(get_current_user)) -> User:
    if current.is_superuser:
        return current
    if _normalized_role(current) == "editor":
        return current
    raise HTTPException(status_code=403, detail="Недостаточно прав: требуется роль editor или администратор")
