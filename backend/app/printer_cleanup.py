from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Printer

# Вкладка «Принтеры» в UI: только сетевые SNMP и ручное добавление.
SNMP_TAB_SOURCES = ("snmp", "manual")


def snmp_tab_clause():
    return Printer.source.in_(SNMP_TAB_SOURCES)


_NOISE_RE = re.compile(
    r"microsoft\s+print\s+to\s+pdf|xps\s+document\s+writer|onenote|send\s+to\s+onenote|"
    r"^fax$|pdf|anydesk|teamviewer|splashtop|rustdesk|"
    r"redirected|virtual|snagit|cutepdf|bullzip|google\s+cloud\s+print|"
    r"webex|document\s+writer|adobe\s+pdf|foxit|pdf24|do\s+pdf|"
    r"remote\s+desktop|terminal\s+easy\s+print|ts\s+print|"
    r"\bswitch\b|officeconnect|superstack|router|firewall|access\s+point",
    re.I,
)


def is_noise_printer_name(name: str) -> bool:
    s = (name or "").strip()
    if not s:
        return True
    return bool(_NOISE_RE.search(s))


def printer_dedupe_key_for_ip(ip: str) -> str:
    return f"ip:{ip.strip()}"


@dataclass
class PrinterCleanupResult:
    deleted_noise: int = 0
    deleted_no_ip: int = 0
    deleted_duplicates: int = 0
    keys_fixed: int = 0
    remaining: int = 0


def _keeper_score(row: Printer) -> tuple[int, float, int]:
    manual = 1 if row.source == "manual" else 0
    snmp_ts = row.last_snmp_at.timestamp() if row.last_snmp_at else 0.0
    poll_ts = row.last_poll_at.timestamp() if row.last_poll_at else 0.0
    return (manual, max(snmp_ts, poll_ts), row.id or 0)


async def purge_workstation_printers(db: AsyncSession) -> int:
    """Удалить принтеры, попавшие с парка ПК (source=agent). Вкладка SNMP их не показывает."""
    r = await db.execute(select(Printer.id).where(Printer.source == "agent"))
    ids = [int(row[0]) for row in r.all()]
    if not ids:
        return 0
    await db.execute(delete(Printer).where(Printer.id.in_(ids)))
    await db.commit()
    return len(ids)


async def cleanup_printers_db(db: AsyncSession) -> PrinterCleanupResult:
    result = PrinterCleanupResult()
    rows = (await db.execute(select(Printer).order_by(Printer.id.asc()))).scalars().all()

    noise_ids: list[int] = []
    no_ip_ids: list[int] = []
    by_ip: dict[str, list[Printer]] = {}

    for row in rows:
        if is_noise_printer_name(row.name):
            noise_ids.append(row.id)
            continue
        ip = (row.ip_address or "").strip()
        if not ip:
            no_ip_ids.append(row.id)
            continue
        by_ip.setdefault(ip, []).append(row)

    if noise_ids:
        await db.execute(delete(Printer).where(Printer.id.in_(noise_ids)))
        result.deleted_noise = len(noise_ids)

    if no_ip_ids:
        await db.execute(delete(Printer).where(Printer.id.in_(no_ip_ids)))
        result.deleted_no_ip = len(no_ip_ids)

    for ip, group in by_ip.items():
        if len(group) <= 1:
            keeper = group[0]
            key = printer_dedupe_key_for_ip(ip)
            if keeper.dedupe_key != key:
                keeper.dedupe_key = key
                keeper.source = "manual" if keeper.source != "manual" else keeper.source
                result.keys_fixed += 1
            continue
        group.sort(key=_keeper_score, reverse=True)
        keeper = group[0]
        keeper.dedupe_key = printer_dedupe_key_for_ip(ip)
        keeper.ip_address = ip
        keeper.is_network = True
        result.keys_fixed += 1
        for dup in group[1:]:
            await db.delete(dup)
            result.deleted_duplicates += 1

    await db.flush()
    result.remaining = int(await db.scalar(select(func.count()).select_from(Printer)) or 0)
    await db.commit()
    return result
