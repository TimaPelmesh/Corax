"""Named AI endpoints and per-purpose roles (chat, embed, tickets, Bitrix).

Endpoints are OpenAI-compatible base URLs (Ollama, LM Studio, remote API).
Roles pick an endpoint + model. Empty endpoint/model inherits from chat, then env.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import AiEndpoint, AiRole, TicketHandlerConfig
from app.wikirag_lm import normalize_lm_base_url, rewrite_lm_base_url_for_runtime
from app.wikirag_options import get_embed_base_url, get_embed_model, get_llm_servers, set_embed_base_url, set_embed_model, set_llm_servers

AI_PURPOSES = ("chat", "embed", "tickets", "bitrix_bot")
_PURPOSE_SET = frozenset(AI_PURPOSES)
_KEY = re.compile(r"^[a-z0-9]{4,16}$")
_MAX_ENDPOINTS = 12


@dataclass(frozen=True)
class ResolvedAi:
    purpose: str
    base_url: str
    model: str
    endpoint_key: str = ""
    endpoint_label: str = ""
    inherited_from: str | None = None
    system_prompt: str = ""


def _label_from_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.hostname or url
    if parsed.port:
        return f"{host}:{parsed.port}"[:64]
    return host[:64]


def _env_chat_url() -> str:
    return rewrite_lm_base_url_for_runtime(normalize_lm_base_url(None))


def _env_chat_model() -> str:
    return (settings.lm_studio_model or "").strip()


def _env_embed_model() -> str:
    return (getattr(settings, "wiki_rag_embed_model", None) or "bge-m3").strip() or "bge-m3"


def purpose_ok(raw: str) -> str:
    value = (raw or "").strip().lower()
    if value not in _PURPOSE_SET:
        raise ValueError(f"Назначение: {', '.join(AI_PURPOSES)}")
    return value


async def ensure_ai_defaults(db: AsyncSession) -> None:
    """Seed endpoints/roles once from legacy JSON / ticket_handler / env."""
    existing = (await db.execute(select(AiEndpoint.id).limit(1))).first()
    if existing:
        await _ensure_roles_exist(db)
        return

    servers = get_llm_servers()
    if not servers:
        try:
            url = _env_chat_url()
        except Exception:  # noqa: BLE001
            url = "http://127.0.0.1:11434/v1"
        servers = [{"id": "local1", "label": _label_from_url(url), "base_url": url}]

    key_by_url: dict[str, str] = {}
    for item in servers[:_MAX_ENDPOINTS]:
        sid = str(item.get("id") or "").strip().lower()
        url = str(item.get("base_url") or "").strip()
        label = str(item.get("label") or "").strip() or _label_from_url(url)
        if not _KEY.fullmatch(sid) or not url.startswith(("http://", "https://")):
            continue
        db.add(AiEndpoint(key=sid, label=label[:64], base_url=url[:512], enabled=True))
        key_by_url[url.rstrip("/").lower()] = sid

    embed_url = (get_embed_base_url() or "").strip()
    embed_model = (get_embed_model() or "").strip() or _env_embed_model()
    embed_key = key_by_url.get(embed_url.rstrip("/").lower(), "") if embed_url else ""

    chat_key = next(iter(key_by_url.values()), "")
    chat_model = _env_chat_model()

    ticket = await db.scalar(select(TicketHandlerConfig).where(TicketHandlerConfig.id == 1).limit(1))
    tickets_url = (ticket.llm_base_url if ticket else "") or ""
    tickets_model = (ticket.llm_model if ticket else "") or ""
    tickets_key = key_by_url.get(tickets_url.rstrip("/").lower(), "") if tickets_url else ""
    if tickets_url and not tickets_key:
        sid = "ticket1"
        if sid not in {k for k in key_by_url.values()}:
            try:
                cleaned = normalize_lm_base_url(tickets_url)
                db.add(AiEndpoint(key=sid, label=_label_from_url(cleaned), base_url=cleaned[:512], enabled=True))
                tickets_key = sid
            except Exception:  # noqa: BLE001
                tickets_key = ""

    seeds = {
        "chat": (chat_key, chat_model),
        "embed": (embed_key, embed_model),
        "tickets": (tickets_key, tickets_model or chat_model),
        "bitrix_bot": ("", ""),  # inherit chat until configured
    }
    for purpose, (endpoint_key, model) in seeds.items():
        db.add(
            AiRole(
                purpose=purpose,
                endpoint_key=endpoint_key or "",
                model=(model or "")[:255],
                system_prompt="",
                enabled=True,
                extras_json="{}",
            )
        )
    await db.commit()


async def _ensure_roles_exist(db: AsyncSession) -> None:
    rows = (await db.execute(select(AiRole))).scalars().all()
    have = {row.purpose for row in rows}
    missing = [p for p in AI_PURPOSES if p not in have]
    if not missing:
        return
    for purpose in missing:
        db.add(AiRole(purpose=purpose, endpoint_key="", model="", system_prompt="", enabled=True, extras_json="{}"))
    await db.commit()


async def list_endpoints(db: AsyncSession) -> list[AiEndpoint]:
    await ensure_ai_defaults(db)
    return list((await db.execute(select(AiEndpoint).order_by(AiEndpoint.id.asc()))).scalars().all())


async def list_roles(db: AsyncSession) -> list[AiRole]:
    await ensure_ai_defaults(db)
    rows = list((await db.execute(select(AiRole))).scalars().all())
    by_purpose = {row.purpose: row for row in rows}
    return [by_purpose[p] for p in AI_PURPOSES if p in by_purpose]


async def replace_endpoints(db: AsyncSession, items: list[dict[str, Any]]) -> list[AiEndpoint]:
    await ensure_ai_defaults(db)
    if len(items) > _MAX_ENDPOINTS:
        raise ValueError(f"Серверов может быть не больше {_MAX_ENDPOINTS}.")
    cleaned: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    for item in items:
        sid = str(item.get("key") or item.get("id") or "").strip().lower()
        if not _KEY.fullmatch(sid):
            raise ValueError("Некорректный идентификатор сервера.")
        if sid in seen_ids:
            raise ValueError("Повторяется идентификатор сервера.")
        url = normalize_lm_base_url(str(item.get("base_url") or ""))
        if url in seen_urls:
            raise ValueError("Такой адрес сервера уже есть.")
        label = " ".join(str(item.get("label") or "").split())[:64] or _label_from_url(url)
        seen_ids.add(sid)
        seen_urls.add(url)
        cleaned.append({"key": sid, "label": label, "base_url": url})

    existing = list((await db.execute(select(AiEndpoint))).scalars().all())
    by_key = {row.key: row for row in existing}
    keep: set[str] = set()
    for item in cleaned:
        keep.add(item["key"])
        row = by_key.get(item["key"])
        if row:
            row.label = item["label"]
            row.base_url = item["base_url"]
            row.enabled = True
        else:
            db.add(AiEndpoint(key=item["key"], label=item["label"], base_url=item["base_url"], enabled=True))
    for row in existing:
        if row.key not in keep:
            await db.delete(row)

    # Keep legacy JSON list in sync for older readers.
    set_llm_servers(
        [{"id": item["key"], "label": item["label"], "base_url": item["base_url"]} for item in cleaned]
    )
    await db.commit()
    # Endpoint URL changes affect every role that points at them.
    await _mirror_legacy(db, touch={"chat", "embed", "tickets"})
    return await list_endpoints(db)


async def upsert_role(
    db: AsyncSession,
    *,
    purpose: str,
    endpoint_key: str | None = None,
    model: str | None = None,
    system_prompt: str | None = None,
    enabled: bool | None = None,
) -> AiRole:
    await ensure_ai_defaults(db)
    purpose = purpose_ok(purpose)
    row = await db.scalar(select(AiRole).where(AiRole.purpose == purpose).limit(1))
    if row is None:
        row = AiRole(purpose=purpose, endpoint_key="", model="", system_prompt="", enabled=True, extras_json="{}")
        db.add(row)

    if endpoint_key is not None:
        key = (endpoint_key or "").strip().lower()
        if key:
            if not _KEY.fullmatch(key):
                raise ValueError("Некорректный endpoint")
            hit = await db.scalar(select(AiEndpoint.id).where(AiEndpoint.key == key).limit(1))
            if hit is None:
                raise ValueError("Сервер AI не найден")
            row.endpoint_key = key
        else:
            row.endpoint_key = ""
    if model is not None:
        row.model = (model or "").strip()[:255]
    if system_prompt is not None:
        row.system_prompt = (system_prompt or "").strip()[:8000]
    if enabled is not None:
        row.enabled = bool(enabled)

    await db.commit()
    await db.refresh(row)
    await _mirror_legacy(db, touch={purpose})
    return row


async def _mirror_legacy(db: AsyncSession, *, touch: set[str] | None = None) -> None:
    """Keep embed JSON + ticket_handler columns aligned with roles.

    Only rewrite legacy stores for purposes that actually changed (plus chat→embed
    inherit). Saving tickets/bitrix must not clobber a WikiRAG embed model/URL.
    """
    changed = {purpose_ok(p) for p in (touch or set(AI_PURPOSES))}

    if changed & {"embed", "chat"}:
        embed_role = await db.scalar(select(AiRole).where(AiRole.purpose == "embed").limit(1))
        resolved_embed = await resolve_ai(db, "embed")
        if resolved_embed.base_url:
            set_embed_base_url(resolved_embed.base_url)
        role_model = (embed_role.model if embed_role else "") or ""
        if role_model.strip():
            set_embed_model(role_model.strip())
        elif "embed" in changed and resolved_embed.model:
            set_embed_model(resolved_embed.model)

    if changed & {"tickets", "chat"}:
        resolved_tickets = await resolve_ai(db, "tickets")
        ticket = await db.scalar(select(TicketHandlerConfig).where(TicketHandlerConfig.id == 1).limit(1))
        if ticket is not None:
            if resolved_tickets.base_url:
                ticket.llm_base_url = resolved_tickets.base_url[:512]
            if resolved_tickets.model:
                ticket.llm_model = resolved_tickets.model[:255]
            await db.commit()


async def resolve_ai(db: AsyncSession, purpose: str) -> ResolvedAi:
    await ensure_ai_defaults(db)
    purpose = purpose_ok(purpose)
    roles = {row.purpose: row for row in (await db.execute(select(AiRole))).scalars().all()}
    endpoints = {row.key: row for row in (await db.execute(select(AiEndpoint))).scalars().all()}

    def pick(p: str) -> tuple[str, str, str, str, str | None]:
        role = roles.get(p)
        if role is None or not role.enabled:
            return "", "", "", "", None
        key = (role.endpoint_key or "").strip()
        ep = endpoints.get(key) if key else None
        if ep and ep.enabled:
            return ep.base_url, (role.model or "").strip(), ep.key, ep.label or "", None
        if p != "chat":
            # inherit endpoint from chat
            chat_url, chat_model, chat_key, chat_label, _ = pick("chat")
            model = (role.model or "").strip() or chat_model
            if chat_url:
                return chat_url, model, chat_key, chat_label, "chat"
        return "", (role.model or "").strip(), "", "", None

    url, model, key, label, inherited = pick(purpose)
    if not url:
        url = _env_chat_url()
        inherited = inherited or "env"
    else:
        url = rewrite_lm_base_url_for_runtime(normalize_lm_base_url(url))

    if not model:
        if purpose == "embed":
            model = _env_embed_model()
        else:
            model = _env_chat_model()

    prompt = ""
    role = roles.get(purpose)
    if role and (role.system_prompt or "").strip():
        prompt = role.system_prompt.strip()
    elif purpose != "chat" and roles.get("chat") and (roles["chat"].system_prompt or "").strip():
        prompt = roles["chat"].system_prompt.strip()

    return ResolvedAi(
        purpose=purpose,
        base_url=url,
        model=model,
        endpoint_key=key,
        endpoint_label=label,
        inherited_from=inherited,
        system_prompt=prompt,
    )


def endpoint_out(row: AiEndpoint) -> dict[str, Any]:
    return {
        "id": row.key,
        "key": row.key,
        "label": row.label or "",
        "base_url": row.base_url or "",
        "enabled": bool(row.enabled),
        "notes": row.notes,
    }


def role_out(row: AiRole, resolved: ResolvedAi | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {
        "purpose": row.purpose,
        "endpoint_key": row.endpoint_key or "",
        "model": row.model or "",
        "system_prompt": row.system_prompt or "",
        "enabled": bool(row.enabled),
    }
    if resolved is not None:
        data["resolved"] = {
            "base_url": resolved.base_url,
            "model": resolved.model,
            "endpoint_key": resolved.endpoint_key,
            "endpoint_label": resolved.endpoint_label,
            "inherited_from": resolved.inherited_from,
        }
    return data
