from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Printer
from app.schemas import AgentPrinterItem

_IP_RE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")

_PRINTER_STATUS_RU: dict[int, str] = {
    1: "other",
    2: "unknown",
    3: "idle",
    4: "printing",
    5: "warmup",
    6: "stopped",
    7: "offline",
}


def extract_ip_from_port(port_name: str | None) -> str | None:
    if not port_name:
        return None
    m = _IP_RE.search(port_name.replace("_", "."))
    if not m:
        return None
    parts = m.group(1).split(".")
    if len(parts) != 4:
        return None
    try:
        if all(0 <= int(p) <= 255 for p in parts):
            return m.group(1)
    except ValueError:
        return None
    return None


def normalize_printer_name(name: str) -> str:
    return " ".join((name or "").strip().lower().split())


def printer_dedupe_key(item: AgentPrinterItem, computer_id: int) -> tuple[str, str | None, bool]:
    ip = (item.ip_address or "").strip() or extract_ip_from_port(item.port_name)
    is_net = bool(item.is_network) or bool(ip)
    name_norm = normalize_printer_name(item.name)
    if ip:
        return f"net:{ip}:{name_norm[:120]}", ip, True
    return f"local:{computer_id}:{name_norm[:120]}", ip, is_net


def agent_status_label(item: AgentPrinterItem) -> str | None:
    if item.status_label:
        return item.status_label.strip()[:64]
    if item.work_offline:
        return "offline"
    if item.status_code is not None:
        return _PRINTER_STATUS_RU.get(item.status_code, f"code_{item.status_code}")
    return None


async def sync_printers_from_agent_report(
    db: AsyncSession,
    *,
    computer_id: int,
    items: list[AgentPrinterItem],
    seen_at: datetime,
) -> None:
    if not items:
        r = await db.execute(
            select(Printer).where(
                Printer.computer_id == computer_id,
                Printer.source == "agent",
                Printer.is_network.is_(False),
            )
        )
        for stale in r.scalars().all():
            await db.delete(stale)
        return

    local_keys: set[str] = set()

    for raw in items:
        name = (raw.name or "").strip()
        if not name:
            continue
        dedupe_key, ip, is_net = printer_dedupe_key(raw, computer_id)
        if not is_net:
            local_keys.add(dedupe_key)

        r = await db.execute(select(Printer).where(Printer.dedupe_key == dedupe_key).limit(1))
        row = r.scalar_one_or_none()
        status = agent_status_label(raw)
        if row is None:
            row = Printer(
                dedupe_key=dedupe_key,
                name=name[:512],
                source="agent",
            )
            db.add(row)
        row.name = name[:512]
        row.driver_name = (raw.driver_name or "").strip()[:512] or None
        row.port_name = (raw.port_name or "").strip()[:512] or None
        row.ip_address = ip
        row.is_network = is_net
        row.is_shared = bool(raw.shared)
        row.is_default = bool(raw.is_default)
        row.agent_status = status
        row.work_offline = raw.work_offline
        row.computer_id = computer_id
        row.last_seen_at = seen_at
        if row.source != "manual":
            row.source = "agent"

    if local_keys:
        r = await db.execute(
            select(Printer).where(
                Printer.computer_id == computer_id,
                Printer.source == "agent",
                Printer.is_network.is_(False),
            )
        )
        for stale in r.scalars().all():
            if stale.dedupe_key not in local_keys:
                await db.delete(stale)
