from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
import secrets

from app.auth import get_current_superuser
from app.database import get_db
from app.ldap_config import get_effective_ldap_config
from app.models import Bitrix24Config, LdapConfig, User, ZabbixConfig
from app.schemas import (
    Bitrix24ConfigOut,
    Bitrix24ConfigUpdate,
    LdapConfigOut,
    LdapConfigUpdate,
    LdapTestRequest,
    LdapTestResponse,
    ZabbixConfigOut,
    ZabbixConfigUpdate,
    ZabbixTestResponse,
)
from app.zabbix_client import ZabbixClientError, probe_zabbix
from app.zabbix_service import invalidate_zabbix_cache
from datetime import datetime, timezone

router = APIRouter(prefix="/settings", tags=["settings"])


def _out(eff, row: LdapConfig | None) -> LdapConfigOut:
    bind_password_set = bool((row.bind_password if row else eff.bind_password).strip())
    return LdapConfigOut(
        enabled=bool(eff.enabled),
        allow_anonymous=bool(getattr(row, "allow_anonymous", False)) if row is not None else bool(getattr(eff, "allow_anonymous", False)),
        uri=eff.uri,
        bind_dn=eff.bind_dn,
        bind_password_set=bind_password_set,
        user_search_base=eff.user_search_base,
        user_filter=eff.user_filter,
        username_attr=eff.username_attr,
        display_name_attr=eff.display_name_attr,
        email_attr=eff.email_attr,
        sync_limit=int(eff.sync_limit),
    )


@router.get("/ldap", response_model=LdapConfigOut)
async def get_ldap_settings(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    eff, row = await get_effective_ldap_config(db)
    return _out(eff, row)


@router.put("/ldap", response_model=LdapConfigOut)
async def update_ldap_settings(
    body: LdapConfigUpdate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    eff, row = await get_effective_ldap_config(db)
    if row is None:
        row = LdapConfig()
        db.add(row)

    if body.enabled is not None:
        row.enabled = bool(body.enabled)
    if body.allow_anonymous is not None:
        row.allow_anonymous = bool(body.allow_anonymous)
    if body.uri is not None:
        row.uri = body.uri
    if body.bind_dn is not None:
        row.bind_dn = body.bind_dn
    if body.bind_password is not None:
        # null => keep, empty string => reset
        row.bind_password = body.bind_password
    if body.user_search_base is not None:
        row.user_search_base = body.user_search_base
    if body.user_filter is not None:
        row.user_filter = body.user_filter
    if body.username_attr is not None:
        row.username_attr = body.username_attr
    if body.display_name_attr is not None:
        row.display_name_attr = body.display_name_attr
    if body.email_attr is not None:
        row.email_attr = body.email_attr
    if body.sync_limit is not None:
        row.sync_limit = int(body.sync_limit)

    await db.commit()
    eff2, row2 = await get_effective_ldap_config(db)
    return _out(eff2, row2)


@router.post("/ldap/test", response_model=LdapTestResponse)
async def test_ldap_settings(
    body: LdapTestRequest,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    try:
        from ldap3 import Connection, Server
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Модуль ldap3 не установлен. Установите зависимости backend.") from exc

    eff, row = await get_effective_ldap_config(db)
    allow_anonymous = (
        bool(body.allow_anonymous)
        if body.allow_anonymous is not None
        else bool(getattr(row, "allow_anonymous", False)) if row is not None else bool(getattr(eff, "allow_anonymous", False))
    )
    uri = (body.uri if body.uri is not None else eff.uri).strip()
    bind_dn = (body.bind_dn if body.bind_dn is not None else eff.bind_dn).strip()
    bind_password = (body.bind_password if body.bind_password is not None else (row.bind_password if row else eff.bind_password)).strip()
    user_search_base = (body.user_search_base if body.user_search_base is not None else eff.user_search_base).strip()
    user_filter = (body.user_filter if body.user_filter is not None else eff.user_filter).strip()
    username_attr = (body.username_attr if body.username_attr is not None else eff.username_attr).strip() or "sAMAccountName"
    display_name_attr = (body.display_name_attr if body.display_name_attr is not None else eff.display_name_attr).strip() or "displayName"
    email_attr = (body.email_attr if body.email_attr is not None else eff.email_attr).strip() or "mail"

    missing: list[str] = []
    if not uri:
        missing.append("LDAP URI")
    if not allow_anonymous:
        if not bind_dn:
            missing.append("Bind DN")
        if not bind_password:
            missing.append("пароль")
    if missing:
        hint = ""
        if "пароль" in missing:
            hint = " (пароль должен быть сохранён или введён для теста)"
        raise HTTPException(status_code=400, detail=f"Для теста заполните: {', '.join(missing)}{hint}.")

    server = Server(uri)
    try:
        if allow_anonymous:
            conn_ctx = Connection(server, auto_bind=True)
        else:
            conn_ctx = Connection(server, user=bind_dn, password=bind_password, auto_bind=True)
        with conn_ctx as conn:
            # Base bind test ok.
            if body.probe_username:
                if not user_search_base:
                    raise HTTPException(status_code=400, detail="Для поиска пользователя нужен base DN (user_search_base).")
                attrs = list({username_attr, display_name_attr, email_attr})
                conn.search(
                    search_base=user_search_base,
                    search_filter=user_filter or "(&(objectClass=user)(objectCategory=person))",
                    attributes=attrs,
                    size_limit=25,
                )
                found = 0
                sample_dn = None
                probe = body.probe_username.strip().lower()
                for e in conn.entries:
                    v = getattr(e, username_attr, None)
                    val = None
                    try:
                        val = v.value if v is not None else None
                    except Exception:
                        val = None
                    if val is None:
                        continue
                    if str(val).strip().lower() == probe:
                        found += 1
                        if sample_dn is None:
                            sample_dn = str(e.entry_dn)
                return LdapTestResponse(
                    ok=True,
                    message="Bind OK, поиск выполнен.",
                    found=found,
                    sample_dn=sample_dn,
                )
            return LdapTestResponse(ok=True, message="Bind OK." if not allow_anonymous else "Anonymous bind OK.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ошибка LDAP: {exc}") from exc


async def _get_or_create_bitrix24(db: AsyncSession) -> Bitrix24Config:
    row = await db.get(Bitrix24Config, 1)
    if row is None:
        row = Bitrix24Config(
            id=1,
            enabled=False,
            incoming_secret=secrets.token_urlsafe(24),
            default_priority="normal",
            default_category="bitrix24",
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


@router.get("/bitrix24", response_model=Bitrix24ConfigOut)
async def get_bitrix24_settings(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_bitrix24(db)
    return Bitrix24ConfigOut(
        enabled=bool(row.enabled),
        incoming_secret=row.incoming_secret or "",
        default_priority=row.default_priority or "normal",
        default_category=row.default_category or "bitrix24",
    )


@router.put("/bitrix24", response_model=Bitrix24ConfigOut)
async def update_bitrix24_settings(
    body: Bitrix24ConfigUpdate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_bitrix24(db)
    patch = body.model_dump(exclude_unset=True)
    if "enabled" in patch and patch["enabled"] is not None:
        row.enabled = bool(patch["enabled"])
    if "incoming_secret" in patch and patch["incoming_secret"] is not None:
        row.incoming_secret = (patch["incoming_secret"] or "").strip()
    if "default_priority" in patch and patch["default_priority"] is not None:
        row.default_priority = (patch["default_priority"] or "").strip() or "normal"
    if "default_category" in patch and patch["default_category"] is not None:
        row.default_category = (patch["default_category"] or "").strip() or "bitrix24"
    await db.commit()
    await db.refresh(row)
    return Bitrix24ConfigOut(
        enabled=bool(row.enabled),
        incoming_secret=row.incoming_secret or "",
        default_priority=row.default_priority or "normal",
        default_category=row.default_category or "bitrix24",
    )

async def _get_or_create_zabbix(db: AsyncSession) -> ZabbixConfig:
    row = await db.get(ZabbixConfig, 1)
    if row is None:
        row = ZabbixConfig(
            id=1,
            enabled=False,
            base_url="",
            api_token="",
            verify_tls=True,
            last_test_message="",
            last_version="",
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


def _zabbix_out(row: ZabbixConfig) -> ZabbixConfigOut:
    return ZabbixConfigOut(
        enabled=bool(row.enabled),
        base_url=row.base_url or "",
        api_token_set=bool((row.api_token or "").strip()),
        verify_tls=bool(row.verify_tls),
        last_test_at=row.last_test_at,
        last_test_ok=row.last_test_ok,
        last_test_message=row.last_test_message or "",
        last_version=row.last_version or "",
        last_hosts_total=row.last_hosts_total,
        last_problems_total=row.last_problems_total,
    )


@router.get("/zabbix", response_model=ZabbixConfigOut)
async def get_zabbix_settings(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    return _zabbix_out(await _get_or_create_zabbix(db))


@router.put("/zabbix", response_model=ZabbixConfigOut)
async def update_zabbix_settings(
    body: ZabbixConfigUpdate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_zabbix(db)
    patch = body.model_dump(exclude_unset=True)
    if "enabled" in patch and patch["enabled"] is not None:
        row.enabled = bool(patch["enabled"])
    if "api_token" in patch and patch["api_token"] is not None:
        token = (patch["api_token"] or "").replace("\u00a0", " ").strip()
        if token:
            row.api_token = token
    if "base_url" in patch and patch["base_url"] is not None:
        row.base_url = (patch["base_url"] or "").replace("\u00a0", " ").strip()
    if "verify_tls" in patch and patch["verify_tls"] is not None:
        row.verify_tls = bool(patch["verify_tls"])
    await db.commit()
    await db.refresh(row)
    invalidate_zabbix_cache()
    return _zabbix_out(row)


@router.post("/zabbix/test", response_model=ZabbixTestResponse)
async def test_zabbix_settings(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    import asyncio

    row = await _get_or_create_zabbix(db)
    try:
        result = await asyncio.to_thread(
            probe_zabbix,
            base_url=row.base_url or "",
            api_token=row.api_token or "",
            verify_tls=bool(row.verify_tls),
        )
    except ZabbixClientError as exc:
        row.last_test_at = datetime.now(timezone.utc)
        row.last_test_ok = False
        row.last_test_message = str(exc)[:500]
        await db.commit()
        invalidate_zabbix_cache()
        return ZabbixTestResponse(ok=False, message=str(exc))
    except Exception as exc:
        row.last_test_at = datetime.now(timezone.utc)
        row.last_test_ok = False
        row.last_test_message = f"Ошибка: {exc}"[:500]
        await db.commit()
        invalidate_zabbix_cache()
        raise HTTPException(status_code=502, detail=f"Ошибка Zabbix: {exc}") from exc

    row.last_test_at = datetime.now(timezone.utc)
    row.last_test_ok = True
    row.last_test_message = result.message[:500]
    row.last_version = (result.version or "")[:64]
    row.last_hosts_total = result.hosts_total
    row.last_problems_total = result.problems_total
    await db.commit()
    invalidate_zabbix_cache()
    return ZabbixTestResponse(
        ok=True,
        message=result.message,
        version=result.version,
        hosts_total=result.hosts_total,
        problems_total=result.problems_total,
        api_url=result.api_url or None,
        auth_mode=result.auth_mode or None,
        scheme=result.scheme or None,
        sample_hosts=list(result.sample_hosts or []),
        sample_problems=list(result.sample_problems or []),
    )
