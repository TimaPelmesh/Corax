from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import LdapConfig


@dataclass(frozen=True)
class EffectiveLdapConfig:
    enabled: bool
    allow_anonymous: bool
    uri: str
    bind_dn: str
    bind_password: str
    user_search_base: str
    user_filter: str
    username_attr: str
    display_name_attr: str
    email_attr: str
    sync_limit: int

    @property
    def configured(self) -> bool:
        if not self.enabled:
            return False
        if not (self.uri.strip() and self.user_search_base.strip()):
            return False
        if self.allow_anonymous:
            return True
        return bool(self.bind_dn.strip() and self.bind_password.strip())


async def get_effective_ldap_config(db: AsyncSession) -> tuple[EffectiveLdapConfig, LdapConfig | None]:
    """
    Prefer DB config if exists; fallback to .env settings otherwise.
    Returns (effective_config, db_row_or_None).
    """
    r = await db.execute(select(LdapConfig).order_by(LdapConfig.id.asc()).limit(1))
    row = r.scalar_one_or_none()
    if row is None:
        eff = EffectiveLdapConfig(
            enabled=bool(settings.ldap_uri.strip() or settings.ldap_user_search_base.strip() or settings.ldap_bind_dn.strip()),
            allow_anonymous=False,
            uri=settings.ldap_uri,
            bind_dn=settings.ldap_bind_dn,
            bind_password=settings.ldap_bind_password,
            user_search_base=settings.ldap_user_search_base,
            user_filter=settings.ldap_user_filter,
            username_attr=settings.ldap_username_attr,
            display_name_attr=settings.ldap_display_name_attr,
            email_attr=settings.ldap_email_attr,
            sync_limit=int(settings.ldap_sync_limit),
        )
        return eff, None

    eff = EffectiveLdapConfig(
        enabled=bool(row.enabled),
        allow_anonymous=bool(getattr(row, "allow_anonymous", False)),
        uri=row.uri or "",
        bind_dn=row.bind_dn or "",
        bind_password=row.bind_password or "",
        user_search_base=row.user_search_base or "",
        user_filter=row.user_filter or "",
        username_attr=row.username_attr or "sAMAccountName",
        display_name_attr=row.display_name_attr or "displayName",
        email_attr=row.email_attr or "mail",
        sync_limit=int(row.sync_limit or 500),
    )
    return eff, row

