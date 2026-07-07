"""Сбор структурированной базы знаний CORAX для WikiRAG (CSV + README, без секретов)."""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    Computer,
    DiskVolume,
    Printer,
    ServiceRequest,
    ServiceRequestCategory,
    ServiceRequestTemplate,
    Tag,
    User,
)
from app.request_category_tree import build_category_tree, collect_category_paths

CORAX_FILE_PREFIX = "CORAX_"
CORAX_README_FILENAME = "CORAX_README.md"
# Совместимость со старым импортом
CORAX_IMPORT_FILENAME = CORAX_README_FILENAME
CORAX_IMPORT_COMMENT = "[CORAX auto] снимок инвентаризации CORAX (CSV + README, связь по computer_id)"

CORAX_BUNDLE_FILENAMES = (
    CORAX_README_FILENAME,
    "CORAX_компьютеры.csv",
    "CORAX_теги_пк.csv",
    "CORAX_ПО.csv",
    "CORAX_периферия.csv",
    "CORAX_диски.csv",
    "CORAX_принтеры.csv",
    "CORAX_заявки.csv",
    "CORAX_пользователи.csv",
)

_STATUS_LABELS = {
    "open": "открыта",
    "in_progress": "в работе",
    "closed": "закрыта",
    "cancelled": "отменена",
}
_PRIORITY_LABELS = {
    "low": "низкий",
    "normal": "обычный",
    "high": "высокий",
    "urgent": "срочный",
}


def _fmt_dt(v: datetime | None) -> str:
    if v is None:
        return ""
    if v.tzinfo is None:
        v = v.replace(tzinfo=timezone.utc)
    return v.astimezone().strftime("%Y-%m-%d %H:%M")


def _cell(v: Any) -> str:
    if v is None:
        return ""
    s = str(v).replace("\r\n", " ").replace("\n", " ").strip()
    return s


def _csv_text(header: list[str], rows: list[list[Any]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow(header)
    for row in rows:
        w.writerow([_cell(x) for x in row])
    return buf.getvalue()


def _label(mapping: dict[str, str], key: str | None) -> str:
    if not key:
        return ""
    return mapping.get(key.strip().lower(), key)


def _parse_disks_json(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


async def _load_snapshot(db: AsyncSession) -> dict[str, Any]:
    users_r = await db.execute(select(User).order_by(User.username))
    users = {u.id: u for u in users_r.scalars().all()}

    tags_r = await db.execute(select(Tag).order_by(Tag.name))
    tags = list(tags_r.scalars().all())

    pcs_r = await db.execute(
        select(Computer)
        .options(
            selectinload(Computer.tags),
            selectinload(Computer.software),
            selectinload(Computer.peripherals),
        )
        .order_by(Computer.hostname)
    )
    computers = list(pcs_r.scalars().all())

    disks_r = await db.execute(select(DiskVolume).order_by(DiskVolume.computer_id, DiskVolume.mount))
    disks_by_pc: dict[int, list[DiskVolume]] = {}
    for d in disks_r.scalars().all():
        disks_by_pc.setdefault(d.computer_id, []).append(d)

    printers_r = await db.execute(select(Printer).order_by(Printer.name))
    printers = list(printers_r.scalars().all())

    reqs_r = await db.execute(select(ServiceRequest).order_by(ServiceRequest.id.desc()).limit(500))
    requests = list(reqs_r.scalars().all())

    tpl_r = await db.execute(select(ServiceRequestTemplate).order_by(ServiceRequestTemplate.title))
    templates = list(tpl_r.scalars().all())

    cat_r = await db.execute(
        select(ServiceRequestCategory).order_by(ServiceRequestCategory.sort_order, ServiceRequestCategory.name)
    )
    categories = collect_category_paths(build_category_tree(list(cat_r.scalars().all())))

    pc_by_id = {c.id: c for c in computers}

    return {
        "users": users,
        "tags": tags,
        "computers": computers,
        "disks_by_pc": disks_by_pc,
        "printers": printers,
        "requests": requests,
        "templates": templates,
        "categories": categories,
        "pc_by_id": pc_by_id,
    }


def _user_label(users: dict[int, User], user_id: int | None) -> str:
    if user_id is None:
        return ""
    u = users.get(user_id)
    if not u:
        return ""
    return (u.full_name or "").strip() or u.username


def _build_readme(data: dict[str, Any], *, generated_at: str) -> str:
    computers: list[Computer] = data["computers"]
    categories: list[str] = data["categories"]
    lines = [
        f"# CORAX — схема данных (снимок {generated_at})",
        "",
        "Набор связанных таблиц инвентаризации. **Главный ключ — `computer_id` и `hostname`.**",
        "При ответах на вопросы всегда называй **hostname** и при необходимости **computer_id**.",
        "",
        "## Файлы",
        "",
        "| Файл | Назначение | Связь |",
        "|------|------------|-------|",
        "| CORAX_компьютеры.csv | Сводка по каждому ПК | `computer_id`, `hostname` — главный справочник |",
        "| CORAX_теги_пк.csv | Теги | `computer_id` + `hostname` + `tag` |",
        "| CORAX_ПО.csv | Установленное ПО | `computer_id` + `hostname` + `software_name` |",
        "| CORAX_периферия.csv | Мониторы, клавиатуры и т.д. | `computer_id` + `hostname` |",
        "| CORAX_диски.csv | Тома дисков | `computer_id` + `hostname` |",
        "| CORAX_принтеры.csv | Принтеры | `computer_id` (может быть пустым для сетевых) |",
        "| CORAX_заявки.csv | Заявки на обслуживание | `computer_id` + `hostname` заявки |",
        "| CORAX_пользователи.csv | Справочник сотрудников | `user_id` → ответственный на ПК |",
        "",
        f"Всего ПК: **{len(computers)}**. Секреты интеграций (Bitrix, LDAP, токены) не включены.",
        "",
    ]
    if categories:
        lines += ["## Категории заявок", ""]
        lines.extend(f"- {p}" for p in categories)
        lines.append("")
    templates: list[ServiceRequestTemplate] = data["templates"]
    if templates:
        lines += ["## Шаблоны заявок", ""]
        for tpl in templates[:40]:
            lines.append(f"- {tpl.title}" + (f" ({tpl.category})" if tpl.category else ""))
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def _build_csv_tables(data: dict[str, Any]) -> dict[str, str]:
    users: dict[int, User] = data["users"]
    computers: list[Computer] = data["computers"]
    disks_by_pc: dict[int, list[DiskVolume]] = data["disks_by_pc"]
    printers: list[Printer] = data["printers"]
    requests: list[ServiceRequest] = data["requests"]
    pc_by_id: dict[int, Computer] = data["pc_by_id"]

    pc_rows: list[list[Any]] = []
    tag_rows: list[list[Any]] = []
    sw_rows: list[list[Any]] = []
    pe_rows: list[list[Any]] = []
    disk_rows: list[list[Any]] = []

    for pc in computers:
        tags = ", ".join(t.name for t in (pc.tags or []))
        for t in pc.tags or []:
            tag_rows.append([pc.id, pc.hostname, t.name, t.id])
        pc_rows.append(
            [
                pc.id,
                pc.hostname,
                tags,
                pc.location or "",
                _user_label(users, pc.assigned_user_id),
                pc.assigned_user_id or "",
                pc.serial_number or "",
                pc.mac_primary or "",
                pc.manufacturer or "",
                pc.model or "",
                pc.cpu or "",
                pc.ram_gb if pc.ram_gb is not None else "",
                pc.gpu_name or "",
                pc.os_name or "",
                pc.os_version or "",
                pc.memory_used_percent if pc.memory_used_percent is not None else "",
                _fmt_dt(pc.last_report_at),
                (pc.notes or "").replace("\n", " ")[:500],
            ]
        )
        for s in sorted((x for x in (pc.software or []) if (x.name or "").strip()), key=lambda x: x.name.lower()):
            sw_rows.append([pc.id, pc.hostname, s.name, s.version or ""])
        for p in sorted((x for x in (pc.peripherals or []) if (x.name or "").strip()), key=lambda x: x.name.lower()):
            pe_rows.append([pc.id, pc.hostname, p.kind or "other", p.name])
        disks = disks_by_pc.get(pc.id) or []
        if disks:
            for d in disks:
                disk_rows.append(
                    [
                        pc.id,
                        pc.hostname,
                        d.mount,
                        d.label or "",
                        d.total_gb if d.total_gb is not None else "",
                        d.used_percent if d.used_percent is not None else "",
                        d.free_gb if d.free_gb is not None else "",
                    ]
                )
        else:
            for d in _parse_disks_json(pc.disks_json):
                disk_rows.append(
                    [
                        pc.id,
                        pc.hostname,
                        d.get("mount") or "",
                        d.get("label") or "",
                        d.get("total_gb") or "",
                        d.get("used_percent") or "",
                        d.get("free_gb") or "",
                    ]
                )

    pr_rows: list[list[Any]] = []
    for pr in printers:
        host = pc_by_id.get(pr.computer_id).hostname if pr.computer_id and pr.computer_id in pc_by_id else ""
        pr_rows.append(
            [
                pr.id,
                pr.computer_id or "",
                host,
                pr.name,
                pr.ip_address or "",
                pr.location or "",
                pr.driver_name or "",
                pr.snmp_model or "",
                "да" if pr.is_network else "нет",
                (pr.notes or "").replace("\n", " ")[:300],
            ]
        )

    req_rows: list[list[Any]] = []
    for req in requests:
        pc_name = pc_by_id.get(req.computer_id).hostname if req.computer_id and req.computer_id in pc_by_id else ""
        req_rows.append(
            [
                req.id,
                req.ticket_no or "",
                req.computer_id or "",
                pc_name,
                req.title,
                _label(_STATUS_LABELS, req.status),
                _label(_PRIORITY_LABELS, req.priority),
                req.category or "",
                req.requester_name or "",
                req.location or "",
                _fmt_dt(req.opened_at or req.created_at),
                _fmt_dt(req.closed_at or req.planned_close_at),
                (req.description or "").replace("\n", " ")[:800],
            ]
        )

    user_rows: list[list[Any]] = []
    for u in sorted(users.values(), key=lambda x: x.username.lower()):
        user_rows.append(
            [
                u.id,
                u.username,
                (u.full_name or "").strip(),
                u.email or "",
                u.role,
                "да" if u.is_active else "нет",
            ]
        )

    return {
        "CORAX_компьютеры.csv": _csv_text(
            [
                "computer_id",
                "hostname",
                "tags",
                "location",
                "assigned_user",
                "assigned_user_id",
                "serial_number",
                "mac",
                "manufacturer",
                "model",
                "cpu",
                "ram_gb",
                "gpu",
                "os_name",
                "os_version",
                "memory_used_percent",
                "last_report_at",
                "notes",
            ],
            pc_rows,
        ),
        "CORAX_теги_пк.csv": _csv_text(["computer_id", "hostname", "tag", "tag_id"], tag_rows),
        "CORAX_ПО.csv": _csv_text(["computer_id", "hostname", "software_name", "version"], sw_rows),
        "CORAX_периферия.csv": _csv_text(["computer_id", "hostname", "kind", "device_name"], pe_rows),
        "CORAX_диски.csv": _csv_text(
            ["computer_id", "hostname", "mount", "label", "total_gb", "used_percent", "free_gb"],
            disk_rows,
        ),
        "CORAX_принтеры.csv": _csv_text(
            [
                "printer_id",
                "computer_id",
                "hostname",
                "printer_name",
                "ip_address",
                "location",
                "driver",
                "snmp_model",
                "is_network",
                "notes",
            ],
            pr_rows,
        ),
        "CORAX_заявки.csv": _csv_text(
            [
                "request_id",
                "ticket_no",
                "computer_id",
                "hostname",
                "title",
                "status",
                "priority",
                "category",
                "requester",
                "location",
                "opened_at",
                "closed_or_planned",
                "description",
            ],
            req_rows,
        ),
        "CORAX_пользователи.csv": _csv_text(
            ["user_id", "username", "full_name", "email", "role", "is_active"],
            user_rows,
        ),
    }


def build_corax_file_bundle(data: dict[str, Any]) -> dict[str, str]:
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    bundle = {CORAX_README_FILENAME: _build_readme(data, generated_at=now)}
    bundle.update(_build_csv_tables(data))
    return bundle


def _trim_csv_rows(csv_text: str, max_rows: int) -> str:
    lines = csv_text.strip().split("\n")
    if len(lines) <= max_rows + 1:
        return csv_text
    return "\n".join(lines[: max_rows + 1]) + f"\n… ещё {len(lines) - max_rows - 1} строк"


def _is_hardware_question(question: str) -> bool:
    from app.wikirag_lm import classify_wikirag_question

    return classify_wikirag_question(question) == "os_hardware"


def _os_upgrade_tier(os_name: str | None, os_version: str | None) -> int:
    """Меньше — выше приоритет миграции на Win10."""
    s = f"{os_name or ''} {os_version or ''}".lower()
    if not s.strip():
        return 1
    if "windows" not in s and "microsoft" not in s and "win" not in s:
        return 1
    if "xp" in s or "vista" in s:
        return 0
    if "7" in s:
        return 0
    if "8" in s:
        return 0
    if "10" in s:
        return 2
    if "11" in s:
        return 3
    return 1


def _ram_gb_value(ram: Any) -> float | None:
    if ram is None or ram == "":
        return None
    try:
        return float(ram)
    except (TypeError, ValueError):
        return None


def _build_slim_computers_csv(
    data: dict[str, Any],
    max_rows: int,
    *,
    upgrade_first: bool = False,
) -> str:
    users: dict[int, User] = data["users"]
    computers: list[Computer] = data["computers"]
    rows: list[list[Any]] = []
    for pc in computers:
        tags = ", ".join(t.name for t in (pc.tags or []))
        rows.append(
            [
                pc.id,
                pc.hostname,
                tags,
                pc.location or "",
                _user_label(users, pc.assigned_user_id),
                pc.os_name or "",
                pc.os_version or "",
                pc.ram_gb if pc.ram_gb is not None else "",
                pc.cpu or "",
            ]
        )
    if upgrade_first:
        rows.sort(
            key=lambda r: (
                _os_upgrade_tier(str(r[5]), str(r[6])),
                _ram_gb_value(r[7]) if _ram_gb_value(r[7]) is not None else 999.0,
                str(r[1]).lower(),
            )
        )
    header = [
        "computer_id",
        "hostname",
        "tags",
        "location",
        "assigned_user",
        "os_name",
        "os_version",
        "ram_gb",
        "cpu",
    ]
    if len(rows) > max_rows:
        rows = rows[:max_rows]
        extra = len(computers) - max_rows
        csv_body = _csv_text(header, rows).rstrip()
        return csv_body + f"\n… ещё {extra} ПК (см. полный CORAX_компьютеры.csv)"
    return _csv_text(header, rows)


def build_inventory_analysis_hint(data: dict[str, Any], question: str) -> str:
    if not _is_hardware_question(question):
        return ""
    computers: list[Computer] = data["computers"]
    if not computers:
        return "## Аналитика парка\nПК в CORAX не найдены."

    os_counts: dict[str, int] = {}
    need_upgrade: list[str] = []
    already_modern: list[str] = []
    low_ram: list[str] = []
    good_candidates: list[str] = []

    for pc in computers:
        os_label = f"{(pc.os_name or '').strip()} {(pc.os_version or '').strip()}".strip() or "(ОС не указана)"
        os_counts[os_label] = os_counts.get(os_label, 0) + 1
        tier = _os_upgrade_tier(pc.os_name, pc.os_version)
        ram = _ram_gb_value(pc.ram_gb)
        host = pc.hostname

        if tier <= 0:
            need_upgrade.append(host)
            if ram is None or ram >= 4:
                good_candidates.append(host)
        elif tier == 1:
            need_upgrade.append(host)
        elif tier >= 2:
            already_modern.append(host)

        if ram is not None and ram < 4:
            low_ram.append(host)

    lines = [
        "## Аналитика парка (для вопроса про ОС / железо)",
        f"Всего ПК: {len(computers)}.",
        "",
        "### Распределение ОС",
    ]
    for label, cnt in sorted(os_counts.items(), key=lambda x: (-x[1], x[0]))[:15]:
        lines.append(f"- {label}: {cnt}")

    def _fmt_hosts(hosts: list[str], limit: int = 40) -> str:
        if not hosts:
            return "(нет)"
        if len(hosts) <= limit:
            return ", ".join(hosts)
        return ", ".join(hosts[:limit]) + f" … и ещё {len(hosts) - limit}"

    lines += [
        "",
        f"### Кандидаты на миграцию с устаревшей ОС ({len(need_upgrade)})",
        _fmt_hosts(sorted(set(need_upgrade))),
        "",
        f"### Уже Windows 10/11 ({len(already_modern)})",
        _fmt_hosts(sorted(set(already_modern))[:30])
        + (f" … всего {len(set(already_modern))}" if len(set(already_modern)) > 30 else ""),
        "",
        f"### Мало RAM (<4 ГБ) — осторожно с Win10 ({len(low_ram)})",
        _fmt_hosts(sorted(set(low_ram))),
        "",
        f"### Приоритетные кандидаты на Win10 (старая ОС + RAM≥4 ГБ или неизвестна): {len(good_candidates)}",
        _fmt_hosts(sorted(set(good_candidates))),
    ]
    return "\n".join(lines)


def build_os_hardware_fallback_answer(data: dict[str, Any], question: str) -> str:
    """Готовый русский ответ по CORAX, если LM Studio вернул reasoning-мусор."""
    if not _is_hardware_question(question):
        return ""
    computers: list[Computer] = data.get("computers") or []
    if not computers:
        return ""
    hint = build_inventory_analysis_hint(data, question)
    if not hint:
        return ""

    n_upgrade = 0
    n_modern = 0
    n_low_ram = 0
    for pc in computers:
        tier = _os_upgrade_tier(pc.os_name, pc.os_version)
        ram = _ram_gb_value(pc.ram_gb)
        if tier <= 1:
            n_upgrade += 1
        elif tier >= 2:
            n_modern += 1
        if ram is not None and ram < 4:
            n_low_ram += 1

    intro = (
        f"**Кому ставить Windows 10** (анализ {len(computers)} ПК в CORAX по os_name, os_version, ram_gb):\n\n"
        f"**Вывод:** приоритет — ПК со старой ОС ({n_upgrade} шт.). "
        f"Уже на Windows 10/11 — {n_modern} шт., им мажорное обновление обычно не нужно. "
        f"Перед Win10 проверьте {n_low_ram} ПК с RAM < 4 ГБ — возможен апгрейд памяти.\n\n"
    )
    return intro + hint.replace("## Аналитика парка (для вопроса про ОС / железо)", "### Детали по группам")


CoraxLevel = Literal["micro", "compact", "medium", "full"]


def _tag_summary(data: dict[str, Any]) -> str:
    computers: list[Computer] = data["computers"]
    tags: list[Tag] = data["tags"]
    counts: dict[int, int] = {t.id: 0 for t in tags}
    for pc in computers:
        for t in pc.tags or []:
            counts[t.id] = counts.get(t.id, 0) + 1
    lines = [f"- {t.name}: {counts.get(t.id, 0)} ПК" for t in tags[:30]]
    return "\n".join(lines) if lines else "(тегов нет)"


def pick_corax_level(n_pc: int, *, has_imported_files: bool, question: str = "") -> CoraxLevel:
    if _is_hardware_question(question):
        if n_pc > 70:
            return "compact"
        if n_pc > 25:
            return "medium"
        return "compact"
    if has_imported_files and n_pc > 20:
        return "micro"
    if n_pc > 70:
        return "micro"
    if n_pc > 35:
        return "compact"
    if n_pc > 12:
        return "medium"
    return "full"


def build_corax_context_from_data(
    data: dict[str, Any],
    max_chars: int,
    level: CoraxLevel = "compact",
    question: str = "",
) -> str:
    """Контекст CORAX для чата; level уменьшают на слабых моделях."""
    bundle = build_corax_file_bundle(data)
    n_pc = len(data["computers"])
    hardware = _is_hardware_question(question)
    hint = build_inventory_analysis_hint(data, question) if hardware else ""

    if level == "micro":
        if hardware and hint:
            text = (
                f"CORAX: в парке **{n_pc}** компьютеров.\n\n"
                f"{hint}\n\n"
                "### CORAX_компьютеры.csv (ключевые колонки)\n```csv\n"
                + _build_slim_computers_csv(data, 50, upgrade_first=True).strip()
                + "\n```"
            )
        else:
            text = (
                f"CORAX: в парке **{n_pc}** компьютеров.\n"
                f"Полные таблицы — в файлах CORAX_*.csv (документы WikiRAG).\n"
                f"Связь: computer_id + hostname.\n\n"
                f"Теги:\n{_tag_summary(data)}"
            )
    elif level == "compact":
        pc_rows = 60 if hardware else 40
        parts = [f"CORAX ({n_pc} ПК). Ключи: computer_id, hostname."]
        if hint:
            parts.append(hint)
        parts += [
            "### CORAX_компьютеры.csv\n```csv\n"
            + (
                _build_slim_computers_csv(data, pc_rows, upgrade_first=hardware).strip()
                if hardware
                else _trim_csv_rows(bundle["CORAX_компьютеры.csv"], pc_rows).strip()
            )
            + "\n```",
            "### CORAX_теги_пк.csv\n```csv\n"
            + _trim_csv_rows(bundle["CORAX_теги_пк.csv"], 60).strip()
            + "\n```",
        ]
        if not hardware:
            parts.append("(ПО и заявки — в CORAX_ПО.csv / CORAX_заявки.csv в документах.)")
        text = "\n\n".join(parts)
    elif level == "medium":
        parts = [
            bundle[CORAX_README_FILENAME].strip()[:1200],
            "### CORAX_компьютеры.csv\n```csv\n"
            + _trim_csv_rows(bundle["CORAX_компьютеры.csv"], min(n_pc, 80)).strip()
            + "\n```",
            "### CORAX_теги_пк.csv\n```csv\n" + bundle["CORAX_теги_пк.csv"].strip() + "\n```",
            "### CORAX_ПО.csv\n```csv\n" + _trim_csv_rows(bundle["CORAX_ПО.csv"], 50).strip() + "\n```",
        ]
        text = "\n\n".join(parts)
    else:
        sw_limit = 80 if n_pc > 25 else 200
        req_limit = 60 if n_pc > 25 else 120
        parts = [
            bundle[CORAX_README_FILENAME].strip()[:1500],
            "### CORAX_компьютеры.csv\n```csv\n" + bundle["CORAX_компьютеры.csv"].strip() + "\n```",
            "### CORAX_теги_пк.csv\n```csv\n" + bundle["CORAX_теги_пк.csv"].strip() + "\n```",
            "### CORAX_ПО.csv\n```csv\n" + _trim_csv_rows(bundle["CORAX_ПО.csv"], sw_limit).strip() + "\n```",
            "### CORAX_заявки.csv\n```csv\n"
            + _trim_csv_rows(bundle["CORAX_заявки.csv"], req_limit).strip()
            + "\n```",
        ]
        text = "\n\n".join(parts)

    if len(text) > max_chars:
        text = text[: max(0, max_chars - 24)].rstrip() + "\n… [контекст обрезан]"
    return text


async def build_corax_knowledge_bundle(db: AsyncSession) -> tuple[dict[str, str], dict[str, int]]:
    data = await _load_snapshot(db)
    bundle = build_corax_file_bundle(data)
    total_chars = sum(len(v) for v in bundle.values())
    stats = {
        "computers": len(data["computers"]),
        "requests": len(data["requests"]),
        "tags": len(data["tags"]),
        "printers": len(data["printers"]),
        "files": len(bundle),
        "chars": total_chars,
    }
    return bundle, stats


async def build_corax_knowledge_markdown(db: AsyncSession) -> tuple[str, dict[str, int]]:
    """Совместимость: один большой текст (README + CSV внутри)."""
    bundle, stats = await build_corax_knowledge_bundle(db)
    parts = [bundle[CORAX_README_FILENAME]]
    for name in CORAX_BUNDLE_FILENAMES:
        if name == CORAX_README_FILENAME:
            continue
        parts.append(f"## {name}\n\n```csv\n{bundle[name].strip()}\n```\n")
    return "\n".join(parts).strip() + "\n", stats


async def build_corax_context_excerpt(
    db: AsyncSession,
    max_chars: int,
    *,
    level: CoraxLevel | None = None,
    has_imported_files: bool = False,
) -> tuple[str, dict[str, int | str]]:
    data = await _load_snapshot(db)
    n_pc = len(data["computers"])
    lvl = level or pick_corax_level(n_pc, has_imported_files=has_imported_files)
    text = build_corax_context_from_data(data, max_chars, lvl)
    stats: dict[str, int | str] = {
        "computers": n_pc,
        "requests": min(len(data["requests"]), 500),
        "tags": len(data["tags"]),
        "chars": len(text),
        "level": lvl,
    }
    return text, stats
