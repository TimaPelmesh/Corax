from __future__ import annotations

import secrets

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ldap_config import EffectiveLdapConfig
from app.models import User


def _hash_password(password: str) -> str:
    import bcrypt

    return bcrypt.hashpw(
        password.encode("utf-8"),
        bcrypt.gensalt(rounds=12),
    ).decode("utf-8")


def _attr_value(entry, attr_name: str) -> str | None:
    try:
        if hasattr(entry, attr_name):
            v = getattr(entry, attr_name).value
        elif attr_name in entry:
            v = entry[attr_name].value
        else:
            return None
        if isinstance(v, list):
            v = v[0] if v else None
        if v is None:
            return None
        s = str(v).strip()
        return s or None
    except Exception:
        return None


async def authenticate_via_ldap(db: AsyncSession, cfg: EffectiveLdapConfig, username: str, password: str) -> User | None:
    """
    Returns local User if LDAP auth succeeds (creates user if missing).
    For AD: searches user DN by username_attr under user_search_base using user_filter, then binds as that DN.
    """
    if not cfg.configured:
        return None
    if not username.strip() or not password:
        return None

    try:
        from ldap3 import Connection, Server
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Модуль ldap3 не установлен. Установите зависимости backend.") from exc

    server = Server(cfg.uri)
    uname = username.strip()

    # 1) Bind (service or anonymous) and find user DN.
    try:
        if cfg.allow_anonymous:
            conn_ctx = Connection(server, auto_bind=True)
        else:
            conn_ctx = Connection(server, user=cfg.bind_dn, password=cfg.bind_password, auto_bind=True)
        with conn_ctx as conn:
            attrs = list({cfg.username_attr, cfg.display_name_attr, cfg.email_attr})
            # Narrow filter with username if possible.
            # If cfg.user_filter is empty, fall back to a safe default.
            base_filter = cfg.user_filter.strip() or "(&(objectClass=user)(objectCategory=person))"
            # Most LDAP servers accept an AND wrapper; keep it simple.
            user_filter = f"(&{base_filter}({cfg.username_attr}={uname}))"
            conn.search(
                search_base=cfg.user_search_base,
                search_filter=user_filter,
                attributes=attrs,
                size_limit=2,
            )
            if not conn.entries:
                return None
            entry = conn.entries[0]
            user_dn = str(entry.entry_dn)
            full_name = _attr_value(entry, cfg.display_name_attr)
            email = _attr_value(entry, cfg.email_attr)
    except Exception:
        # Avoid leaking internal LDAP errors in auth path; treat as auth failure.
        return None

    # 2) Bind as the user with provided password.
    try:
        with Connection(server, user=user_dn, password=password, auto_bind=True):
            pass
    except Exception:
        return None

    # 3) Upsert local user.
    r = await db.execute(select(User).where(User.username == uname))
    user = r.scalar_one_or_none()
    if user is None:
        one_time = secrets.token_urlsafe(12)
        user = User(
            username=uname,
            email=email,
            full_name=full_name,
            hashed_password=_hash_password(one_time),
            is_superuser=False,
            role="directory",
            is_active=True,
            is_ldap=True,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
        return user

    # Refresh profile fields if present in LDAP.
    changed = False
    if full_name and user.full_name != full_name:
        user.full_name = full_name
        changed = True
    if email and user.email != email:
        user.email = email
        changed = True
    if not user.is_active:
        user.is_active = True
        changed = True
    if changed:
        await db.commit()
        await db.refresh(user)
    return user

