from __future__ import annotations

from dataclasses import dataclass

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_superuser
from app.config import settings
from app.database import get_db
from app.models import User

router = APIRouter(prefix="/users/admin/bitrix24", tags=["bitrix24"])


@dataclass(frozen=True)
class B24User:
    login: str | None
    email: str | None
    full_name: str | None
    active: bool


def _norm(s: str | None) -> str | None:
    if s is None:
        return None
    t = s.strip()
    return t or None


def _full_name(first: str | None, last: str | None, second: str | None) -> str | None:
    parts = [p.strip() for p in [last or "", first or "", second or ""] if p and p.strip()]
    return " ".join(parts) if parts else None


async def _fetch_b24_users(*, webhook_base: str, limit: int) -> list[B24User]:
    base = webhook_base.rstrip("/")
    if not base.startswith("http"):
        raise HTTPException(status_code=400, detail="BITRIX24_WEBHOOK_URL должен начинаться с http(s)://")

    out: list[B24User] = []
    start = 0
    timeout = httpx.Timeout(20.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        while True:
            # Bitrix24 REST: user.get
            # https://.../rest/<id>/<token>/user.get?start=0
            url = f"{base}/user.get"
            params = {"start": start}
            r = await client.get(url, params=params)
            if r.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Bitrix24 HTTP {r.status_code}: {r.text[:300]}")
            data = r.json()
            if not isinstance(data, dict) or "result" not in data:
                raise HTTPException(status_code=502, detail="Bitrix24: неожиданный ответ user.get")
            items = data.get("result") or []
            if not isinstance(items, list):
                raise HTTPException(status_code=502, detail="Bitrix24: result не список")

            for it in items:
                if not isinstance(it, dict):
                    continue
                login = _norm(str(it.get("LOGIN") or "")) or None
                email = _norm(str(it.get("EMAIL") or "")) or None
                first = _norm(str(it.get("NAME") or "")) or None
                last = _norm(str(it.get("LAST_NAME") or "")) or None
                second = _norm(str(it.get("SECOND_NAME") or "")) or None
                active_raw = str(it.get("ACTIVE") or "").strip().upper()
                active = active_raw != "N"
                out.append(B24User(login=login, email=email, full_name=_full_name(first, last, second), active=active))
                if len(out) >= limit:
                    return out

            nxt = data.get("next")
            if nxt is None:
                break
            try:
                start = int(nxt)
            except Exception:
                break
    return out


@router.post("/import")
async def import_bitrix24_users(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    url = (settings.bitrix24_webhook_url or "").strip()
    if not url:
        raise HTTPException(
            status_code=400,
            detail="Bitrix24 не настроен: задайте BITRIX24_WEBHOOK_URL в backend/.env",
        )

    limit = max(1, int(getattr(settings, "bitrix24_import_limit", 500) or 500))
    users = await _fetch_b24_users(webhook_base=url, limit=limit)

    created = 0
    updated = 0
    skipped = 0
    touched: list[dict] = []

    # Index existing users by username/email.
    r = await db.execute(select(User))
    existing = list(r.scalars().all())
    by_username = {u.username.strip().lower(): u for u in existing if u.username}
    by_email = {u.email.strip().lower(): u for u in existing if u.email}

    for b in users:
        key_login = (b.login or "").strip()
        key_email = (b.email or "").strip()
        if not key_login and not key_email:
            skipped += 1
            continue

        row: User | None = None
        if key_login:
            row = by_username.get(key_login.lower())
        if row is None and key_email:
            row = by_email.get(key_email.lower())

        if row is None:
            # Create local user (so it appears in assignee directory).
            # Password is random; for real auth use LDAP or create manually.
            import secrets
            from app.auth import hash_password

            username = key_login or (key_email.split("@", 1)[0] if "@" in key_email else key_email)
            username = (username or "").strip()[:64]
            if not username:
                skipped += 1
                continue
            if username.lower() in by_username:
                # Collision: do not overwrite, skip.
                skipped += 1
                continue

            tmp_pass = secrets.token_urlsafe(12)
            row = User(
                username=username,
                email=key_email or None,
                full_name=b.full_name,
                hashed_password=hash_password(tmp_pass),
                is_superuser=False,
                role="directory",
                is_active=bool(b.active),
                is_ldap=False,
            )
            db.add(row)
            await db.flush()
            by_username[username.lower()] = row
            if row.email:
                by_email[row.email.lower()] = row
            created += 1
            touched.append({"username": row.username, "action": "created"})
            continue

        # Update minimal profile fields; do not touch password/superuser/ldap flag.
        changed = False
        if key_email and (row.email or "").strip().lower() != key_email.lower():
            row.email = key_email
            by_email[key_email.lower()] = row
            changed = True
        if b.full_name and (row.full_name or "").strip() != b.full_name:
            row.full_name = b.full_name
            changed = True
        if row.is_active != bool(b.active):
            row.is_active = bool(b.active)
            changed = True

        if changed:
            updated += 1
            touched.append({"username": row.username, "action": "updated"})
        else:
            skipped += 1

    await db.commit()
    return {
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "fetched": len(users),
        "items": touched[:200],
    }

