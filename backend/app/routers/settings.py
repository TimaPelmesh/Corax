from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import AsyncIterator

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_policy import get_or_create_policy
from app.auth import get_current_editor_or_superuser, get_current_superuser
from app.database import get_db
from app.glpi_assets import export_glpi_assets, import_glpi_assets, list_local_computers
from app.glpi_devices import export_glpi_devices, import_glpi_devices, list_local_devices, list_remote_devices
from app.glpi_client import GlpiClientError, GlpiIdentity, GlpiPushResult, create_test_ticket, probe_glpi
from app.glpi_sync import apply_glpi_ticket_links, creds_from_row, export_glpi_tickets, import_glpi_tickets
from app.ldap_config import get_effective_ldap_config
from app.models import AgentCollectRequest, Bitrix24Config, GlpiConfig, LdapConfig, User, ZabbixConfig
from app.schemas import (
    Bitrix24ConfigOut,
    Bitrix24ConfigUpdate,
    GlpiConfigOut,
    GlpiConfigUpdate,
    GlpiIdentityOut,
    GlpiTestResponse,
    GlpiTestTicketIn,
    GlpiTestTicketOut,
    GlpiAssetSyncIn,
    GlpiComputerRowOut,
    GlpiDeviceRowOut,
    GlpiDeviceSyncIn,
    GlpiTicketLinksIn,
    GlpiTicketLinksOut,
    GlpiTicketSyncIn,
    GlpiTicketSyncOut,
    LdapConfigOut,
    LdapConfigUpdate,
    LdapTestRequest,
    LdapTestResponse,
    AgentCollectNowIn,
    AgentCollectPolicyOut,
    AgentCollectPolicyUpdate,
    ZabbixConfigOut,
    ZabbixConfigUpdate,
    ZabbixTestResponse,
)
from app.zabbix_client import ZabbixClientError, probe_zabbix
from app.zabbix_service import invalidate_zabbix_cache
from datetime import datetime, timezone

router = APIRouter(prefix="/settings", tags=["settings"])


def _identity_out(identity: GlpiIdentity | None) -> GlpiIdentityOut | None:
    if identity is None:
        return None
    if not any(
        (
            identity.user_id,
            identity.username,
            identity.display_name,
            identity.profile,
            identity.entity,
        )
    ):
        return None
    return GlpiIdentityOut(
        user_id=identity.user_id,
        username=identity.username,
        display_name=identity.display_name,
        profile=identity.profile,
        entity=identity.entity,
    )


def _identity_from_row(row: GlpiConfig) -> GlpiIdentityOut | None:
    raw = (getattr(row, "last_identity_json", None) or "").strip()
    if not raw or raw == "{}":
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    identity = GlpiIdentityOut(
        user_id=int(data["user_id"]) if data.get("user_id") is not None else None,
        username=(str(data["username"]).strip() or None) if data.get("username") else None,
        display_name=(str(data["display_name"]).strip() or None) if data.get("display_name") else None,
        profile=(str(data["profile"]).strip() or None) if data.get("profile") else None,
        entity=(str(data["entity"]).strip() or None) if data.get("entity") else None,
    )
    if not any((identity.user_id, identity.username, identity.display_name, identity.profile, identity.entity)):
        return None
    return identity


def _store_identity(row: GlpiConfig, identity: GlpiIdentity | None) -> None:
    out = _identity_out(identity)
    if out is None:
        row.last_identity_json = "{}"
        return
    row.last_identity_json = json.dumps(
        {
            "user_id": out.user_id,
            "username": out.username,
            "display_name": out.display_name,
            "profile": out.profile,
            "entity": out.entity,
        },
        ensure_ascii=False,
    )


def _policy_out(row) -> AgentCollectPolicyOut:
    return AgentCollectPolicyOut(
        mode=(row.mode or "on_demand").strip().lower(),
        time_hhmm=(row.time_hhmm or "09:00")[:5],
        weekday=int(row.weekday or 0),
        timezone=(row.timezone or "Europe/Moscow").strip() or "Europe/Moscow",
        generation=int(row.generation or 0),
        last_reason=(row.last_reason or "idle").strip() or "idle",
        poll_minutes=int(row.poll_minutes or 5),
    )


@router.get("/agent-policy", response_model=AgentCollectPolicyOut)
async def get_agent_policy(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    return _policy_out(await get_or_create_policy(db))


@router.put("/agent-policy", response_model=AgentCollectPolicyOut)
async def put_agent_policy(
    body: AgentCollectPolicyUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await get_or_create_policy(db)
    row.mode = body.mode
    row.time_hhmm = body.time_hhmm.strip()[:5] or "09:00"
    row.weekday = int(body.weekday)
    row.timezone = body.timezone.strip() or "Europe/Moscow"
    row.poll_minutes = int(body.poll_minutes)
    await db.commit()
    await db.refresh(row)
    return _policy_out(row)


@router.post("/agent-policy/collect-now", response_model=AgentCollectPolicyOut)
async def collect_agents_now(
    body: AgentCollectNowIn = Body(default_factory=AgentCollectNowIn),
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await get_or_create_policy(db)
    host = ((body.hostname if body else None) or "").strip()
    if host:
        db.add(AgentCollectRequest(hostname=host))
    else:
        row.generation = int(row.generation or 0) + 1
        row.last_reason = "now"
    await db.commit()
    await db.refresh(row)
    return _policy_out(row)


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


_GLPI_MODES = frozenset({"v2", "legacy"})
_GLPI_GRANTS = frozenset({"password", "client_credentials"})


async def _get_or_create_glpi(db: AsyncSession) -> GlpiConfig:
    row = await db.get(GlpiConfig, 1)
    if row is None:
        row = GlpiConfig(
            id=1,
            enabled=False,
            base_url="",
            api_mode="v2",
            grant_type="password",
            verify_tls=True,
            last_test_message="",
            last_version="",
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


def _glpi_out(row: GlpiConfig) -> GlpiConfigOut:
    return GlpiConfigOut(
        enabled=bool(row.enabled),
        base_url=row.base_url or "",
        api_mode=(row.api_mode or "v2").strip().lower() or "v2",
        grant_type=(row.grant_type or "password").strip().lower() or "password",
        client_id=row.client_id or "",
        client_secret_set=bool((row.client_secret or "").strip()),
        username=row.username or "",
        password_set=bool((row.password or "").strip()),
        app_token_set=bool((row.app_token or "").strip()),
        user_token_set=bool((row.user_token or "").strip()),
        verify_tls=bool(row.verify_tls),
        last_test_at=row.last_test_at,
        last_test_ok=row.last_test_ok,
        last_test_message=row.last_test_message or "",
        last_version=row.last_version or "",
        identity=_identity_from_row(row),
    )


def _clean_setting(value: str) -> str:
    return (value or "").replace("\u00a0", " ").strip()


def _set_glpi_secret(row: GlpiConfig, attr: str, value: str | None) -> None:
    if value is None:
        return
    cleaned = _clean_setting(value)
    if cleaned:
        setattr(row, attr, cleaned)


def _require_glpi_enabled(row: GlpiConfig) -> None:
    if not row.enabled:
        raise HTTPException(status_code=400, detail="Включите интеграцию GLPI и сохраните подключение.")
    if not (row.base_url or "").strip():
        raise HTTPException(status_code=400, detail="Укажите URL GLPI.")


@router.get("/glpi", response_model=GlpiConfigOut)
async def get_glpi_settings(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    return _glpi_out(await _get_or_create_glpi(db))


@router.put("/glpi", response_model=GlpiConfigOut)
async def update_glpi_settings(
    body: GlpiConfigUpdate,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_glpi(db)
    patch = body.model_dump(exclude_unset=True)
    if "enabled" in patch and patch["enabled"] is not None:
        row.enabled = bool(patch["enabled"])
    if "base_url" in patch and patch["base_url"] is not None:
        row.base_url = _clean_setting(patch["base_url"])[:512]
    if "api_mode" in patch and patch["api_mode"] is not None:
        mode = _clean_setting(patch["api_mode"]).lower()
        if mode not in _GLPI_MODES:
            raise HTTPException(status_code=400, detail="api_mode: v2 или legacy")
        row.api_mode = mode
    if "grant_type" in patch and patch["grant_type"] is not None:
        grant = _clean_setting(patch["grant_type"]).lower()
        if grant not in _GLPI_GRANTS:
            raise HTTPException(status_code=400, detail="grant_type: password или client_credentials")
        row.grant_type = grant
    if "client_id" in patch and patch["client_id"] is not None:
        row.client_id = _clean_setting(patch["client_id"])[:255]
    if "username" in patch and patch["username"] is not None:
        row.username = _clean_setting(patch["username"])[:255]
    if "verify_tls" in patch and patch["verify_tls"] is not None:
        row.verify_tls = bool(patch["verify_tls"])
    _set_glpi_secret(row, "client_secret", patch.get("client_secret"))
    _set_glpi_secret(row, "password", patch.get("password"))
    _set_glpi_secret(row, "app_token", patch.get("app_token"))
    _set_glpi_secret(row, "user_token", patch.get("user_token"))
    await db.commit()
    await db.refresh(row)
    return _glpi_out(row)


@router.post("/glpi/test", response_model=GlpiTestResponse)
async def test_glpi_settings(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_glpi(db)
    creds = creds_from_row(row)
    try:
        result = await asyncio.to_thread(probe_glpi, creds)
    except GlpiClientError as exc:
        row.last_test_at = datetime.now(timezone.utc)
        row.last_test_ok = False
        row.last_test_message = str(exc)[:500]
        await db.commit()
        return GlpiTestResponse(ok=False, message=str(exc), api_mode=creds.mode)
    except Exception as exc:
        row.last_test_at = datetime.now(timezone.utc)
        row.last_test_ok = False
        row.last_test_message = f"Ошибка: {exc}"[:500]
        await db.commit()
        raise HTTPException(status_code=502, detail=f"Ошибка GLPI: {exc}") from exc

    row.last_test_at = datetime.now(timezone.utc)
    row.last_test_ok = True
    row.last_test_message = result.message[:500]
    if result.version:
        row.last_version = result.version[:64]
    _store_identity(row, result.identity)
    await db.commit()
    return GlpiTestResponse(
        ok=True,
        message=result.message,
        version=result.version,
        api_mode=result.api_mode,
        tickets_visible=result.tickets_visible,
        identity=_identity_out(result.identity),
    )


@router.post("/glpi/test-ticket", response_model=GlpiTestTicketOut)
async def create_glpi_test_ticket(
    body: GlpiTestTicketIn | None = None,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Создаёт одну заявку в GLPI от текущего профиля — проверка «жив ли обмен»."""
    row = await _get_or_create_glpi(db)
    _require_glpi_enabled(row)
    payload = body or GlpiTestTicketIn()
    try:
        result = await asyncio.to_thread(
            create_test_ticket,
            creds_from_row(row),
            title=payload.title,
            content=payload.content,
        )
    except GlpiClientError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ошибка GLPI: {exc}") from exc

    row.last_test_at = datetime.now(timezone.utc)
    row.last_test_ok = True
    row.last_test_message = result.message[:500]
    if result.version:
        row.last_version = result.version[:64]
    _store_identity(row, result.identity)
    await db.commit()
    return GlpiTestTicketOut(
        ok=True,
        message=result.message,
        glpi_id=result.glpi_id,
        url=result.url,
        identity=_identity_out(result.identity),
        version=result.version,
        api_mode=result.api_mode,
    )


@router.post("/glpi/import-tickets", response_model=GlpiTicketSyncOut)
async def import_glpi_tickets_api(
    body: GlpiTicketSyncIn | None = None,
    user: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_glpi(db)
    _require_glpi_enabled(row)
    payload = body or GlpiTicketSyncIn()
    try:
        result = await import_glpi_tickets(creds_from_row(row), created_by_id=user.id, limit=payload.limit)
    except GlpiClientError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GlpiTicketSyncOut(
        created=result.created,
        updated=result.updated,
        skipped=result.skipped,
        failed=result.failed,
        message=result.message,
        errors=result.errors,
    )


@router.post("/glpi/export-tickets", response_model=GlpiTicketSyncOut)
async def export_glpi_tickets_api(
    body: GlpiTicketSyncIn | None = None,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_glpi(db)
    _require_glpi_enabled(row)
    payload = body or GlpiTicketSyncIn()
    try:
        result = await export_glpi_tickets(
            db,
            creds_from_row(row),
            limit=payload.limit,
            request_ids=payload.request_ids,
            mode=payload.mode,
        )
    except GlpiClientError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GlpiTicketSyncOut(
        created=result.created,
        updated=result.updated,
        skipped=result.skipped,
        failed=result.failed,
        message=result.message,
        errors=result.errors,
    )


@router.post("/glpi/ticket-links", response_model=GlpiTicketLinksOut)
async def patch_glpi_ticket_links(
    body: GlpiTicketLinksIn,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Переписать или снять glpi_id у заявок CORAX (без обращения в GLPI)."""
    row = await _get_or_create_glpi(db)
    pairs = [(item.request_id, item.glpi_id) for item in body.items]
    result = await apply_glpi_ticket_links(db, pairs, base_url=row.base_url)
    return GlpiTicketLinksOut(
        updated=result.updated,
        cleared=result.created,
        skipped=result.skipped,
        message=result.message,
        errors=result.errors,
    )


@router.post("/glpi/export-tickets/stream")
async def export_glpi_tickets_stream(
    body: GlpiTicketSyncIn | None = None,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """SSE: progress → done|error. Сопоставление по glpi_id и по названию."""
    row = await _get_or_create_glpi(db)
    _require_glpi_enabled(row)
    payload = body or GlpiTicketSyncIn()
    creds = creds_from_row(row)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple] = asyncio.Queue()

    def on_progress(done: int, total: int, result: GlpiPushResult) -> None:
        loop.call_soon_threadsafe(
            queue.put_nowait,
            (
                "progress",
                {
                    "done": done,
                    "total": total,
                    "percent": int(round(100 * done / total)) if total else 100,
                    "corax_id": result.corax_id,
                    "glpi_id": result.glpi_id,
                    "action": result.action,
                    "error": result.error,
                    "detail": result.detail,
                },
            ),
        )

    async def runner() -> None:
        try:
            result = await export_glpi_tickets(
                db,
                creds,
                limit=payload.limit,
                request_ids=payload.request_ids,
                mode=payload.mode,
                on_progress=on_progress,
            )
            await queue.put(
                (
                    "done",
                    {
                        "created": result.created,
                        "updated": result.updated,
                        "skipped": result.skipped,
                        "failed": result.failed,
                        "message": result.message,
                        "errors": result.errors,
                    },
                )
            )
        except Exception as exc:
            await queue.put(("error", {"error": str(exc)}))

    def _sse(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    async def event_stream() -> AsyncIterator[str]:
        task = asyncio.create_task(runner())
        try:
            while True:
                kind, data = await queue.get()
                yield _sse(kind, data)
                if kind in {"done", "error"}:
                    break
        finally:
            await task

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/glpi/import-assets", response_model=GlpiTicketSyncOut)
async def import_glpi_assets_api(
    body: GlpiTicketSyncIn | None = None,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_glpi(db)
    _require_glpi_enabled(row)
    payload = body or GlpiTicketSyncIn()
    try:
        result = await import_glpi_assets(db, creds_from_row(row), limit=payload.limit)
    except GlpiClientError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GlpiTicketSyncOut(
        created=result.created,
        updated=result.updated,
        skipped=result.skipped,
        failed=result.failed,
        message=result.message,
        errors=result.errors,
    )


@router.post("/glpi/export-assets", response_model=GlpiTicketSyncOut)
async def export_glpi_assets_api(
    body: GlpiAssetSyncIn | None = None,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_glpi(db)
    _require_glpi_enabled(row)
    payload = body or GlpiAssetSyncIn()
    try:
        result = await export_glpi_assets(
            db,
            creds_from_row(row),
            limit=payload.limit,
            computer_ids=payload.computer_ids,
            mode=payload.mode,
        )
    except GlpiClientError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return GlpiTicketSyncOut(
        created=result.created,
        updated=result.updated,
        skipped=result.skipped,
        failed=result.failed,
        message=result.message,
        errors=result.errors,
    )


@router.get("/glpi/computers", response_model=list[GlpiComputerRowOut])
async def list_glpi_computers_local(
    limit: int = 200,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Список ПК CORAX (hostname + IP) для выбора выгрузки."""
    return await list_local_computers(db, limit=limit)


def _device_sync_out(result) -> GlpiTicketSyncOut:
    return GlpiTicketSyncOut(
        created=result.created,
        updated=result.updated,
        skipped=result.skipped,
        failed=result.failed,
        message=result.message,
        errors=result.errors,
    )


@router.get("/glpi/devices", response_model=list[GlpiDeviceRowOut])
async def list_glpi_devices_local(
    kind: str,
    limit: int = 200,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    if kind not in ("monitor", "printer"):
        raise HTTPException(status_code=400, detail="Можно передать только мониторы или принтеры")
    return await list_local_devices(db, kind, limit=limit)


@router.post("/glpi/remote-devices", response_model=list[GlpiDeviceRowOut])
async def list_glpi_devices_remote(
    body: GlpiDeviceSyncIn,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_glpi(db)
    _require_glpi_enabled(row)
    try:
        return await list_remote_devices(creds_from_row(row), body.kind, limit=body.limit)
    except GlpiClientError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/glpi/import-devices", response_model=GlpiTicketSyncOut)
async def import_glpi_devices_api(
    body: GlpiDeviceSyncIn,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_glpi(db)
    _require_glpi_enabled(row)
    try:
        result = await import_glpi_devices(
            db,
            creds_from_row(row),
            kind=body.kind,
            limit=body.limit,
            glpi_ids=body.ids,
        )
    except GlpiClientError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _device_sync_out(result)


@router.post("/glpi/export-devices", response_model=GlpiTicketSyncOut)
async def export_glpi_devices_api(
    body: GlpiDeviceSyncIn,
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_glpi(db)
    _require_glpi_enabled(row)
    try:
        result = await export_glpi_devices(
            db,
            creds_from_row(row),
            kind=body.kind,
            limit=body.limit,
            ids=body.ids,
        )
    except GlpiClientError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _device_sync_out(result)
