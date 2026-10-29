"""Pure rules for the gaps that kept CORAX under 9: settings status, night feed, SLA, dump check, SSH pin."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

SLA_HOURS = {"urgent": 4, "critical": 4, "high": 8, "normal": 72, "low": 168}
STALE_DAYS = 14
CERT_WARN_DAYS = 14

_TAG = re.compile(r"<[^>]+>")


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def connector_state(
    *,
    enabled: bool,
    configured: bool,
    last_ok: bool | None = None,
    checked_at: datetime | None = None,
    now: datetime,
    probe: bool = True,
    stale_days: int = STALE_DAYS,
) -> str:
    """ok, error, stale, or off. Local pages do not use this."""
    if not enabled:
        return "off"
    if not configured:
        return "error"
    if not probe:
        return "ok"
    if last_ok is False:
        return "error"
    moment = _aware(checked_at)
    if moment is None or last_ok is not True:
        return "stale"
    if now - moment > timedelta(days=stale_days):
        return "stale"
    return "ok"


def cert_state(*, enabled: bool, not_after: datetime | None, now: datetime) -> str:
    if not enabled:
        return "off"
    moment = _aware(not_after)
    if moment is None:
        return "stale"
    if moment <= now:
        return "error"
    if moment - now <= timedelta(days=CERT_WARN_DAYS):
        return "stale"
    return "ok"


def settings_board(facts: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    """One row per settings card. `code` is translated in the UI."""
    zabbix = connector_state(
        enabled=bool(facts.get("zabbix_enabled")),
        configured=bool(facts.get("zabbix_configured")),
        last_ok=facts.get("zabbix_last_ok"),
        checked_at=facts.get("zabbix_checked_at"),
        now=now,
    )
    glpi = connector_state(
        enabled=bool(facts.get("glpi_enabled")),
        configured=bool(facts.get("glpi_configured")),
        last_ok=facts.get("glpi_last_ok"),
        checked_at=facts.get("glpi_checked_at"),
        now=now,
    )
    ldap = connector_state(
        enabled=bool(facts.get("ldap_enabled")),
        configured=bool(facts.get("ldap_configured")),
        now=now,
        probe=False,
    )
    if facts.get("bitrix_paused"):
        bitrix_state, bitrix_code = "off", "paused"
    else:
        bitrix_state = connector_state(
            enabled=bool(facts.get("bitrix_enabled")),
            configured=bool(facts.get("bitrix_configured")),
            now=now,
            probe=False,
        )
        bitrix_code = "configured" if bitrix_state == "ok" else bitrix_state
    tokens = int(facts.get("agent_tokens") or 0)
    silent = int(facts.get("agent_silent") or 0)
    if tokens <= 0:
        token_state, token_code = "off", "off"
    elif silent > 0:
        token_state, token_code = "stale", "silent"
    else:
        token_state, token_code = "ok", "tokens_ok"
    https = cert_state(
        enabled=bool(facts.get("https_enabled")),
        not_after=facts.get("https_not_after"),
        now=now,
    )
    servers = int(facts.get("llm_servers") or 0)
    pg = bool(facts.get("pg_dump"))
    rows = [
        {"path": "/settings/llm", "state": "ok" if servers else "off", "code": "servers" if servers else "off", "count": servers},
        {"path": "/settings/tags", "state": "local", "code": "local", "count": 0},
        {"path": "/settings/categories", "state": "local", "code": "local", "count": 0},
        {"path": "/users", "state": "local", "code": "local", "count": 0},
        {"path": "/settings/ldap", "state": ldap, "code": "configured" if ldap == "ok" else ldap, "count": 0},
        {"path": "/settings/bitrix24", "state": bitrix_state, "code": bitrix_code, "count": 0},
        {"path": "/settings/zabbix", "state": zabbix, "code": _probe_code(zabbix), "count": 0},
        {"path": "/settings/database", "state": "ok" if pg else "error", "code": "tools_ready" if pg else "tools_missing", "count": 0},
        {"path": "/settings/glpi", "state": glpi, "code": _probe_code(glpi), "count": 0},
        {"path": "/settings/agent-tokens", "state": token_state, "code": token_code, "count": silent},
        {"path": "/settings/agent-bundle", "state": "local", "code": "local", "count": 0},
        {"path": "/settings/wol", "state": "ok" if facts.get("wol_enabled") else "off", "code": "configured" if facts.get("wol_enabled") else "off", "count": 0},
        {"path": "/settings/https", "state": https, "code": _cert_code(https), "count": 0},
    ]
    if facts.get("backup_due"):
        for row in rows:
            if row["path"] == "/settings/database" and row["state"] == "ok":
                row["state"] = "stale"
                row["code"] = "backup_due"
    return rows


def _probe_code(state: str) -> str:
    if state == "ok":
        return "test_ok"
    if state == "error":
        return "test_failed"
    if state == "stale":
        return "never_checked"
    return "off"


def _cert_code(state: str) -> str:
    if state == "ok":
        return "cert_ok"
    if state == "error":
        return "cert_expired"
    if state == "stale":
        return "cert_soon"
    return "off"


def overdue_reason(
    priority: str | None,
    opened_at: datetime | None,
    planned_close_at: datetime | None,
    now: datetime,
) -> str | None:
    """deadline when the planned date passed, age when the priority window passed."""
    planned = _aware(planned_close_at)
    if planned is not None and planned < now:
        return "deadline"
    opened = _aware(opened_at)
    if opened is None:
        return None
    hours = SLA_HOURS.get((priority or "normal").strip().lower(), SLA_HOURS["normal"])
    if now - opened >= timedelta(hours=hours):
        return "age"
    return None


def night_feed(
    *,
    offline: list[dict[str, Any]],
    tickets: list[dict[str, Any]],
    stock: list[dict[str, Any]],
    limit: int = 8,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for host in offline:
        name = str(host.get("hostname") or "").strip()
        if not name:
            continue
        items.append({"kind": "offline", "host": name, "href": "/computers"})
    for ticket in tickets:
        items.append(
            {
                "kind": "sla",
                "ticket_id": int(ticket["id"]),
                "title": str(ticket.get("title") or "")[:180],
                "reason": ticket.get("reason") or "age",
                "href": "/requests/database",
            }
        )
    for row in stock:
        items.append(
            {
                "kind": "stock",
                "name": str(row.get("name") or "")[:180],
                "available": int(row.get("available") or 0),
                "href": "/warehouse",
            }
        )
    return items[:limit]


def computer_reply(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "Компьютер по вашему имени не найден. Напишите hostname одним сообщением после команды."
    lines = ["Ваши компьютеры:"]
    for row in rows[:5]:
        ping = row.get("ping") or "нет ping"
        ip = row.get("ip") or "нет IP"
        lines.append(f"{row.get('hostname')} — {ping}, {ip}")
    return "\n".join(lines)


def stock_reply(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "Позиций с остатком 2 и ниже нет."
    lines = ["На складе мало:"]
    for row in rows[:8]:
        lines.append(f"{row.get('name')} — {int(row.get('available') or 0)} шт.")
    return "\n".join(lines)


def sla_reply(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "Просроченных заявок нет."
    lines = ["Заявки вне срока:"]
    for row in rows[:8]:
        mark = "срок прошёл" if row.get("reason") == "deadline" else "держится дольше нормы"
        lines.append(f"№{row.get('id')} {row.get('title')} — {mark}")
    return "\n".join(lines)


def dump_can_open(data: bytes) -> tuple[bool, str]:
    """Custom-format pg_dump starts with PGDMP. This checks the archive header, not a restore."""
    if len(data) < 64:
        return False, "short"
    if not data.startswith(b"PGDMP"):
        return False, "header"
    version = data[5]
    if version < 1 or version > 20:
        return False, "version"
    return True, "ok"


def backup_due(enabled: bool, interval_hours: int, last_run_at: datetime | None, now: datetime) -> bool:
    if not enabled:
        return False
    hours = int(interval_hours or 0)
    if hours < 1:
        return False
    moment = _aware(last_run_at)
    if moment is None:
        return True
    return now - moment >= timedelta(hours=hours)


def host_key_action(stored: str | None, seen: str) -> str:
    """remember on first sight, accept the same fingerprint, reject a change."""
    current = (seen or "").strip()
    if not current:
        return "reject"
    saved = (stored or "").strip()
    if not saved:
        return "remember"
    if saved == current:
        return "accept"
    return "reject"


def _plain(value: object) -> str:
    text = _TAG.sub(" ", str(value or ""))
    return " ".join(text.split())


def parse_followups(payload: object) -> list[dict[str, Any]]:
    rows = payload if isinstance(payload, list) else []
    if isinstance(payload, dict):
        nested = payload.get("data") or payload.get("items") or payload.get("results")
        rows = nested if isinstance(nested, list) else []
    out: list[dict[str, Any]] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        content = _plain(raw.get("content") or raw.get("description") or "")
        if not content:
            continue
        author = raw.get("user") or raw.get("users_id") or raw.get("users_id_editor") or ""
        if isinstance(author, dict):
            author = author.get("name") or author.get("username") or author.get("id") or ""
        out.append(
            {
                "id": raw.get("id"),
                "content": content[:2000],
                "author": str(author)[:120],
                "at": str(raw.get("date") or raw.get("date_creation") or raw.get("date_mod") or "")[:40],
            }
        )
    return out


def parse_licenses(payload: object) -> list[dict[str, Any]]:
    rows = payload if isinstance(payload, list) else []
    if isinstance(payload, dict):
        nested = payload.get("data") or payload.get("items") or payload.get("results")
        rows = nested if isinstance(nested, list) else []
    out: list[dict[str, Any]] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        name = _plain(raw.get("name") or raw.get("completename") or "")
        if not name:
            continue
        software = raw.get("software") or raw.get("softwares_id") or ""
        if isinstance(software, dict):
            software = software.get("name") or ""
        number = raw.get("number")
        try:
            seats = int(number) if number is not None and str(number).strip() != "" else None
        except (TypeError, ValueError):
            seats = None
        out.append({"id": raw.get("id"), "name": name[:255], "software": _plain(software)[:255], "seats": seats})
    return out
