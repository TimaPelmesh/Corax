"""Сбор базы знаний CORAX для WikiRAG: MD в папке corax-inventory (без секретов)."""

from __future__ import annotations

import csv
import io
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import (
    Computer,
    DiskVolume,
    NetworkDevice,
    NetworkLink,
    Printer,
    ServiceRequest,
    ServiceRequestCategory,
    ServiceRequestTemplate,
    Tag,
    User,
)
from app.network_classify import infer_network_role
from app.request_category_tree import build_category_tree, collect_category_paths

CORAX_FOLDER = "corax-inventory"
CORAX_FILE_PREFIX = "CORAX_"
# Индекс — в корне библиотеки WikiRAG; доменные MD — в corax-inventory/
CORAX_INDEX_FILENAME = "00_system_index.md"
CORAX_README_FILENAME = CORAX_INDEX_FILENAME
CORAX_IMPORT_FILENAME = CORAX_INDEX_FILENAME
CORAX_IMPORT_COMMENT = (
    "[CORAX auto] снимок инвентаризации в папке corax-inventory "
    "(Markdown по доменам, связь по computer_id / hostname)"
)

CORAX_COMPUTERS_MD = f"{CORAX_FOLDER}/CORAX_компьютеры.md"
CORAX_HARDWARE_MD = f"{CORAX_FOLDER}/CORAX_железо.md"
CORAX_SOFTWARE_MD = f"{CORAX_FOLDER}/CORAX_ПО.md"
CORAX_SOFTWARE_STATS_MD = f"{CORAX_FOLDER}/CORAX_ПО_статистика.md"
CORAX_PARK_STATS_MD = f"{CORAX_FOLDER}/CORAX_статистика.md"
CORAX_PRINTERS_MD = f"{CORAX_FOLDER}/CORAX_принтеры.md"
CORAX_NETWORK_MD = f"{CORAX_FOLDER}/CORAX_сеть.md"
CORAX_TICKETS_MD = f"{CORAX_FOLDER}/CORAX_заявки.md"
CORAX_USERS_MD = f"{CORAX_FOLDER}/CORAX_пользователи.md"
CORAX_TAGS_MD = f"{CORAX_FOLDER}/CORAX_теги.md"

CORAX_FILE_COMMENTS: dict[str, str] = {
    CORAX_INDEX_FILENAME: "[CORAX] Системный индекс (корень): что где лежит в corax-inventory",
    CORAX_COMPUTERS_MD: "[CORAX] ПК: hostname / ОС / IP / локация / ответственный",
    CORAX_HARDWARE_MD: "[CORAX] Железо: CPU, RAM, GPU, диски, периферия по ПК",
    CORAX_SOFTWARE_MD: "[CORAX] Установленное ПО по hostname",
    CORAX_SOFTWARE_STATS_MD: "[CORAX] Статистика ПО: программа → число ПК / список хостов",
    CORAX_PARK_STATS_MD: "[CORAX] Сводка парка: ОС/CPU/RAM, сеть (шлюзы/DNS), принтеры, теги",
    CORAX_PRINTERS_MD: "[CORAX] Принтеры (сеть / привязка к ПК)",
    CORAX_NETWORK_MD: "[CORAX] Сетевое оборудование (свитчи, роутеры, шлюзы, DNS, SNMP)",
    CORAX_TICKETS_MD: "[CORAX] Сервисные заявки",
    CORAX_USERS_MD: "[CORAX] Пользователи + закреплённые ПК и ПО",
    CORAX_TAGS_MD: "[CORAX] Теги и привязка к ПК",
}

# Старые плоские снимки / CSV — удаляем при импорте/sync.
CORAX_LEGACY_FILENAMES: tuple[str, ...] = (
    "CORAX_README.md",
    f"{CORAX_FOLDER}/00_system_index.md",
    "CORAX_база_знаний.md",
    "CORAX_компьютеры.md",
    "CORAX_железо.md",
    "CORAX_ПО.md",
    "CORAX_принтеры.md",
    "CORAX_заявки.md",
    "CORAX_пользователи.md",
    "CORAX_теги.md",
    "CORAX_компьютеры.csv",
    "CORAX_теги_пк.csv",
    "CORAX_ПО.csv",
    "CORAX_периферия.csv",
    "CORAX_диски.csv",
    "CORAX_принтеры.csv",
    "CORAX_заявки.csv",
    "CORAX_пользователи.csv",
)


def corax_file_comment(filename: str) -> str:
    return CORAX_FILE_COMMENTS.get(filename) or CORAX_IMPORT_COMMENT


CORAX_BUNDLE_FILENAMES = (
    CORAX_INDEX_FILENAME,
    CORAX_COMPUTERS_MD,
    CORAX_HARDWARE_MD,
    CORAX_SOFTWARE_MD,
    CORAX_SOFTWARE_STATS_MD,
    CORAX_PARK_STATS_MD,
    CORAX_PRINTERS_MD,
    CORAX_NETWORK_MD,
    CORAX_TICKETS_MD,
    CORAX_USERS_MD,
    CORAX_TAGS_MD,
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

    net_r = await db.execute(select(NetworkDevice).order_by(NetworkDevice.ip_address))
    network_devices = list(net_r.scalars().all())

    links_r = await db.execute(select(NetworkLink))
    network_links = list(links_r.scalars().all())

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
        "network_devices": network_devices,
        "network_links": network_links,
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


def _pc_heading(pc: Computer) -> str:
    host = (pc.hostname or f"id-{pc.id}").strip()
    return f"## {host} (computer_id={pc.id})"


def _line(label: str, value: Any) -> str | None:
    s = _cell(value)
    if not s:
        return None
    return f"- **{label}:** {s}"


def _counter_lines(counter: Counter[str], *, top: int | None = None) -> list[str]:
    items = counter.most_common(top) if top else sorted(counter.items(), key=lambda x: (-x[1], x[0].lower()))
    return [f"- {name}: **{count}**" for name, count in items if name]


def _device_role(dev: NetworkDevice) -> str:
    return infer_network_role(
        hostname=dev.hostname,
        sys_name=dev.sys_name,
        device_type=dev.device_type,
        source=dev.source,
    )


def _build_park_stats_md(data: dict[str, Any], *, generated_at: str) -> str:
    """Максимум агрегированной статистики парка для WikiRAG."""
    users: dict[int, User] = data["users"]
    computers: list[Computer] = data["computers"]
    printers: list[Printer] = data["printers"]
    network_devices: list[NetworkDevice] = data.get("network_devices") or []
    network_links: list[NetworkLink] = data.get("network_links") or []
    requests: list[ServiceRequest] = data["requests"]
    tags: list[Tag] = data["tags"]
    disks_by_pc: dict[int, list[DiskVolume]] = data["disks_by_pc"]

    os_c: Counter[str] = Counter()
    cpu_c: Counter[str] = Counter()
    ram_c: Counter[str] = Counter()
    mfr_c: Counter[str] = Counter()
    model_c: Counter[str] = Counter()
    loc_c: Counter[str] = Counter()
    ping_c: Counter[str] = Counter()
    mb_c: Counter[str] = Counter()
    pe_kind_c: Counter[str] = Counter()
    tag_c: Counter[str] = Counter()
    assignee_c: Counter[str] = Counter()
    low_ram = 0
    with_notes = 0
    with_ip = 0
    sw_unique: set[str] = set()
    sw_installs = 0

    for pc in computers:
        os_label = " ".join(x for x in (pc.os_name or "", pc.os_version or "") if x).strip() or "неизвестно"
        os_c[os_label] += 1
        cpu_c[(pc.cpu or "").strip() or "неизвестно"] += 1
        if pc.ram_gb is None:
            ram_c["неизвестно"] += 1
        else:
            ram_c[f"{int(round(float(pc.ram_gb)))} ГБ"] += 1
            if float(pc.ram_gb) < 8:
                low_ram += 1
        mfr_c[(pc.manufacturer or "").strip() or "неизвестно"] += 1
        model_c[(pc.model or "").strip() or "неизвестно"] += 1
        loc_c[(pc.location or "").strip() or "без локации"] += 1
        ping_c[(getattr(pc, "ping_status", None) or "unknown").strip() or "unknown"] += 1
        mb = " / ".join(
            x
            for x in (
                (getattr(pc, "motherboard_manufacturer", None) or "").strip(),
                (getattr(pc, "motherboard_product", None) or "").strip(),
            )
            if x
        ) or "неизвестно"
        mb_c[mb] += 1
        if (pc.notes or "").strip():
            with_notes += 1
        if (getattr(pc, "ip_address", None) or "").strip():
            with_ip += 1
        assignee = _user_label(users, pc.assigned_user_id) or "без ответственного"
        assignee_c[assignee] += 1
        for t in pc.tags or []:
            if (t.name or "").strip():
                tag_c[t.name.strip()] += 1
        for p in pc.peripherals or []:
            pe_kind_c[(p.kind or "other").strip() or "other"] += 1
        for s in pc.software or []:
            name = (s.name or "").strip()
            if not name:
                continue
            sw_installs += 1
            sw_unique.add(name.lower())

    net_type_c: Counter[str] = Counter()
    net_role_c: Counter[str] = Counter()
    net_vendor_c: Counter[str] = Counter()
    net_snmp_c: Counter[str] = Counter()
    gateways: list[str] = []
    dns_servers: list[str] = []
    for dev in network_devices:
        dtype = (dev.device_type or "unknown").strip() or "unknown"
        role = _device_role(dev)
        net_type_c[dtype] += 1
        net_role_c[role] += 1
        net_vendor_c[(dev.vendor or "").strip() or "неизвестно"] += 1
        net_snmp_c[(dev.snmp_status or "unknown").strip() or "unknown"] += 1
        title = (dev.hostname or dev.sys_name or dev.ip_address or f"net-{dev.id}").strip()
        ip = (dev.ip_address or "").strip()
        label = f"{title}" + (f" ({ip})" if ip else "")
        if role == "gateway":
            gateways.append(label)
        elif role == "dns":
            dns_servers.append(label)

    pr_net = sum(1 for p in printers if p.is_network)
    pr_local = len(printers) - pr_net
    pr_loc_c: Counter[str] = Counter(
        (p.location or "").strip() or "без локации" for p in printers
    )
    pr_model_c: Counter[str] = Counter(
        (p.snmp_model or p.driver_name or p.name or "неизвестно").strip() or "неизвестно"
        for p in printers
    )

    ticket_status_c: Counter[str] = Counter(_label(_STATUS_LABELS, r.status) for r in requests)
    ticket_prio_c: Counter[str] = Counter(_label(_PRIORITY_LABELS, r.priority) for r in requests)

    link_type_c: Counter[str] = Counter((ln.link_type or "unknown").strip() or "unknown" for ln in network_links)

    disk_vols = sum(len(v) for v in disks_by_pc.values())

    parts = [
        f"# Статистика парка CORAX (снимок {generated_at})",
        "",
        "Агрегированные срезы для аналитики WikiRAG: ОС, железо, сеть (шлюзы/DNS), принтеры, теги, заявки.",
        "",
        "## Общие цифры",
        "",
        f"- ПК: **{len(computers)}**",
        f"- С IP-адресом: **{with_ip}**",
        f"- С заметками: **{with_notes}**",
        f"- ПК с ОЗУ менее 8 ГБ: **{low_ram}**",
        f"- Уникальных программ: **{len(sw_unique)}**",
        f"- Установок ПО: **{sw_installs}**",
        f"- Томов дисков: **{disk_vols}**",
        f"- Принтеры: **{len(printers)}** (сеть: {pr_net}, локальные/привязанные: {pr_local})",
        f"- Сетевые устройства: **{len(network_devices)}**",
        f"- Связей сети (LLDP/карта): **{len(network_links)}**",
        f"- Пользователи панели: **{len(users)}**",
        f"- Теги в справочнике: **{len(tags)}**",
        f"- Заявки в снимке: **{len(requests)}**",
        "",
        "## ОС",
        "",
        *_counter_lines(os_c),
        "",
        "## Процессоры (топ 40)",
        "",
        *_counter_lines(cpu_c, top=40),
        "",
        "## ОЗУ",
        "",
        *_counter_lines(ram_c),
        "",
        "## Производители ПК",
        "",
        *_counter_lines(mfr_c, top=30),
        "",
        "## Модели ПК (топ 40)",
        "",
        *_counter_lines(model_c, top=40),
        "",
        "## Материнские платы (топ 30)",
        "",
        *_counter_lines(mb_c, top=30),
        "",
        "## Локации ПК",
        "",
        *_counter_lines(loc_c, top=40),
        "",
        "## Ping / доступность",
        "",
        *_counter_lines(ping_c),
        "",
        "## Периферия по видам",
        "",
        *(_counter_lines(pe_kind_c) or ["- (нет данных)"]),
        "",
        "## Теги (число ПК)",
        "",
        *(_counter_lines(tag_c) or ["- (тегов нет)"]),
        "",
        "## Ответственные (число ПК)",
        "",
        *_counter_lines(assignee_c, top=50),
        "",
        "## Сеть: роли (шлюз / DNS / свитч…)",
        "",
        *(_counter_lines(net_role_c) if network_devices else ["- (сетевых устройств нет)"]),
        "",
        "## Сеть: типы устройств",
        "",
        *(_counter_lines(net_type_c) if network_devices else ["- (сетевых устройств нет)"]),
        "",
        "## Сеть: вендоры",
        "",
        *(_counter_lines(net_vendor_c, top=30) if network_devices else ["- (нет)"]),
        "",
        "## Сеть: SNMP-статус",
        "",
        *(_counter_lines(net_snmp_c) if network_devices else ["- (нет)"]),
        "",
        "## Шлюзы (gateway)",
        "",
    ]
    if gateways:
        parts.extend(f"- {g}" for g in sorted(gateways, key=str.lower))
    else:
        parts.append("- (не обнаружены по имени/роли)")
    parts += ["", "## DNS-серверы", ""]
    if dns_servers:
        parts.extend(f"- {d}" for d in sorted(dns_servers, key=str.lower))
    else:
        parts.append("- (не обнаружены по имени/роли)")
    parts += [
        "",
        "## Типы связей сети",
        "",
        *(_counter_lines(link_type_c) or ["- (связей нет)"]),
        "",
        "## Принтеры: локации",
        "",
        *(_counter_lines(pr_loc_c) if printers else ["- (принтеров нет)"]),
        "",
        "## Принтеры: модели (топ 40)",
        "",
        *(_counter_lines(pr_model_c, top=40) if printers else ["- (принтеров нет)"]),
        "",
        "## Заявки: статусы",
        "",
        *(_counter_lines(ticket_status_c) if requests else ["- (заявок нет)"]),
        "",
        "## Заявки: приоритеты",
        "",
        *(_counter_lines(ticket_prio_c) if requests else ["- (заявок нет)"]),
        "",
    ]
    return "\n".join(parts).strip() + "\n"


def _build_readme(data: dict[str, Any], *, generated_at: str) -> str:
    """00_system_index.md в корне библиотеки — карта папки corax-inventory."""
    computers: list[Computer] = data["computers"]
    printers: list[Printer] = data["printers"]
    network_devices: list[NetworkDevice] = data.get("network_devices") or []
    users: dict[int, User] = data["users"]
    tags: list[Tag] = data["tags"]
    requests: list[ServiceRequest] = data["requests"]
    categories: list[str] = data["categories"]

    sw_installs = 0
    for pc in computers:
        sw_installs += sum(1 for s in (pc.software or []) if (s.name or "").strip())

    lines = [
        f"# CORAX Inventory — системный индекс (снимок {generated_at})",
        "",
        f"Этот файл лежит в **корне** базы знаний. Данные снимка — в папке **`{CORAX_FOLDER}/`**.",
        "**Главный ключ — `computer_id` и `hostname`.** В ответах всегда называй hostname.",
        "",
        "## Сводка парка",
        "",
        f"- ПК: **{len(computers)}**",
        f"- Установок ПО: **{sw_installs}**",
        f"- Принтеры: **{len(printers)}**",
        f"- Сетевые устройства: **{len(network_devices)}**",
        f"- Пользователи панели: **{len(users)}**",
        f"- Теги: **{len(tags)}**",
        f"- Заявки в снимке: **{len(requests)}**",
        "",
        "## Карта файлов",
        "",
        "| Файл | Назначение | Типичные вопросы |",
        "|------|------------|------------------|",
        f"| `00_system_index.md` (корень) | Этот индекс | что где лежит |",
        f"| `{CORAX_FOLDER}/CORAX_статистика.md` | Сводная статистика парка / сети / принтеров | сколько шлюзов, DNS, Win10 |",
        f"| `{CORAX_FOLDER}/CORAX_компьютеры.md` | Карточки ПК (ОС, IP, локация) | сколько ПК, кто где |",
        f"| `{CORAX_FOLDER}/CORAX_железо.md` | CPU / RAM / GPU / диски | слабые ПК, апгрейд |",
        f"| `{CORAX_FOLDER}/CORAX_ПО.md` | ПО по каждому hostname | что стоит на HOST |",
        f"| `{CORAX_FOLDER}/CORAX_ПО_статистика.md` | Программа → число ПК / список | у кого Chrome / 1С |",
        f"| `{CORAX_FOLDER}/CORAX_пользователи.md` | Сотрудник → ПК → ПО | у Ивана какое ПО |",
        f"| `{CORAX_FOLDER}/CORAX_принтеры.md` | Принтеры + сводка | IP принтера, привязка |",
        f"| `{CORAX_FOLDER}/CORAX_сеть.md` | Свитчи / роутеры / шлюзы / DNS | сетевое оборудование |",
        f"| `{CORAX_FOLDER}/CORAX_теги.md` | Теги ↔ hostname | ПК в группе |",
        f"| `{CORAX_FOLDER}/CORAX_заявки.md` | Сервисные заявки | открытые тикеты |",
        "",
        "Секреты интеграций (Bitrix, LDAP, токены) **не включены**.",
        "",
        "Секции оформлены как `## hostname (computer_id=N)` или `## Программа` — удобно для чанков и аналитики.",
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


def _build_md_documents(data: dict[str, Any], *, generated_at: str) -> dict[str, str]:
    """Читаемые MD по доменам — основной корпус для WikiRAG-индекса."""
    users: dict[int, User] = data["users"]
    computers: list[Computer] = data["computers"]
    disks_by_pc: dict[int, list[DiskVolume]] = data["disks_by_pc"]
    printers: list[Printer] = data["printers"]
    requests: list[ServiceRequest] = data["requests"]
    tags: list[Tag] = data["tags"]
    pc_by_id: dict[int, Computer] = data["pc_by_id"]

    computers_parts = [
        f"# Компьютеры CORAX (снимок {generated_at})",
        "",
        f"Всего ПК: **{len(computers)}**. Ниже — карточка каждого хоста.",
        "",
    ]
    hardware_parts = [
        f"# Железо CORAX (снимок {generated_at})",
        "",
        "CPU, RAM, GPU, диски и периферия по каждому ПК.",
        "",
    ]
    software_parts = [
        f"# Установленное ПО CORAX (снимок {generated_at})",
        "",
        "Список программ по hostname. Версия указана, если известна.",
        "",
    ]
    tags_parts = [
        f"# Теги CORAX (снимок {generated_at})",
        "",
    ]

    tag_to_hosts: dict[str, list[str]] = {}

    for pc in computers:
        assignee = _user_label(users, pc.assigned_user_id)
        tag_names = [t.name for t in (pc.tags or []) if (t.name or "").strip()]
        for tname in tag_names:
            tag_to_hosts.setdefault(tname, []).append(pc.hostname)

        computers_parts.append(_pc_heading(pc))
        computers_parts.append("")
        for item in (
            _line("Локация", pc.location),
            _line("Ответственный", assignee),
            _line("IP", getattr(pc, "ip_address", None)),
            _line("Производитель", pc.manufacturer),
            _line("Модель", pc.model),
            _line("Серийный номер", pc.serial_number),
            _line("MAC", pc.mac_primary),
            _line("ОС", " ".join(x for x in (pc.os_name or "", pc.os_version or "") if x).strip()),
            _line("Теги", ", ".join(tag_names)),
            _line("Последний отчёт", _fmt_dt(pc.last_report_at)),
            _line("Заметки", (pc.notes or "").strip()[:500] or None),
        ):
            if item:
                computers_parts.append(item)
        computers_parts.append("")

        hardware_parts.append(_pc_heading(pc))
        hardware_parts.append("")
        for item in (
            _line("CPU", pc.cpu),
            _line("RAM, ГБ", pc.ram_gb if pc.ram_gb is not None else None),
            _line("Занято RAM, %", pc.memory_used_percent if pc.memory_used_percent is not None else None),
            _line("GPU", pc.gpu_name),
            _line("Материнская плата", " / ".join(
                x for x in (
                    getattr(pc, "motherboard_manufacturer", None) or "",
                    getattr(pc, "motherboard_product", None) or "",
                )
                if x
            ) or None),
        ):
            if item:
                hardware_parts.append(item)

        disks = disks_by_pc.get(pc.id) or []
        disk_lines: list[str] = []
        if disks:
            for d in disks:
                bits = [d.mount or "?"]
                if d.label:
                    bits.append(str(d.label))
                if d.total_gb is not None:
                    bits.append(f"{d.total_gb:g} ГБ")
                if d.used_percent is not None:
                    bits.append(f"занято {d.used_percent}%")
                if d.free_gb is not None:
                    bits.append(f"свободно {d.free_gb:g} ГБ")
                disk_lines.append("- " + ", ".join(bits))
        else:
            for d in _parse_disks_json(pc.disks_json):
                bits = [str(d.get("mount") or "?")]
                if d.get("label"):
                    bits.append(str(d["label"]))
                if d.get("total_gb") not in (None, ""):
                    bits.append(f"{d['total_gb']} ГБ")
                if d.get("used_percent") not in (None, ""):
                    bits.append(f"занято {d['used_percent']}%")
                if d.get("free_gb") not in (None, ""):
                    bits.append(f"свободно {d['free_gb']} ГБ")
                disk_lines.append("- " + ", ".join(bits))
        if disk_lines:
            hardware_parts.append("- **Диски:**")
            hardware_parts.extend(disk_lines)

        pe_list = sorted(
            (x for x in (pc.peripherals or []) if (x.name or "").strip()),
            key=lambda x: ((x.kind or ""), x.name.lower()),
        )
        if pe_list:
            hardware_parts.append("- **Периферия:**")
            for p in pe_list:
                kind = (p.kind or "other").strip()
                hardware_parts.append(f"  - [{kind}] {p.name}")
        hardware_parts.append("")

        sw_list = sorted(
            (x for x in (pc.software or []) if (x.name or "").strip()),
            key=lambda x: x.name.lower(),
        )
        software_parts.append(_pc_heading(pc))
        software_parts.append("")
        if not sw_list:
            software_parts.append("- (ПО не собрано)")
        else:
            software_parts.append(f"- Всего программ: **{len(sw_list)}**")
            for s in sw_list:
                ver = (s.version or "").strip()
                software_parts.append(f"- {s.name}" + (f" — {ver}" if ver else ""))
        software_parts.append("")

    if tag_to_hosts:
        tags_parts.append("## По тегам")
        tags_parts.append("")
        for tname in sorted(tag_to_hosts.keys(), key=str.lower):
            hosts = sorted(tag_to_hosts[tname], key=str.lower)
            tags_parts.append(f"### {tname}")
            tags_parts.append(f"ПК ({len(hosts)}): " + ", ".join(hosts))
            tags_parts.append("")
    else:
        tags_parts.append("(тегов нет)")
        tags_parts.append("")
    if tags:
        tags_parts.append("## Справочник тегов")
        tags_parts.append("")
        for t in tags:
            tags_parts.append(f"- {t.name}" + (f" (id={t.id})" if t.id else ""))
        tags_parts.append("")

    printers_parts = [
        f"# Принтеры CORAX (снимок {generated_at})",
        "",
        f"Всего: **{len(printers)}**.",
        "",
        "## Сводка",
        "",
        f"- Сетевые: **{sum(1 for p in printers if p.is_network)}**",
        f"- Локальные / привязанные к ПК: **{sum(1 for p in printers if not p.is_network)}**",
        "",
    ]
    pr_by_loc: Counter[str] = Counter((p.location or "").strip() or "без локации" for p in printers)
    if printers:
        printers_parts.append("### По локациям")
        printers_parts.append("")
        printers_parts.extend(_counter_lines(pr_by_loc))
        printers_parts.append("")
    for pr in printers:
        host = pc_by_id.get(pr.computer_id).hostname if pr.computer_id and pr.computer_id in pc_by_id else ""
        title = (pr.name or f"printer-{pr.id}").strip()
        printers_parts.append(f"## {title} (printer_id={pr.id})")
        printers_parts.append("")
        for item in (
            _line("Hostname ПК", host),
            _line("computer_id", pr.computer_id),
            _line("IP", pr.ip_address),
            _line("Локация", pr.location),
            _line("Драйвер", pr.driver_name),
            _line("Модель SNMP", pr.snmp_model),
            _line("Сетевой", "да" if pr.is_network else "нет"),
            _line("Счётчик страниц", getattr(pr, "page_count", None)),
            _line("Заметки", (pr.notes or "").strip()[:300] or None),
        ):
            if item:
                printers_parts.append(item)
        printers_parts.append("")

    tickets_parts = [
        f"# Заявки CORAX (снимок {generated_at})",
        "",
        f"Показаны последние **{len(requests)}** заявок.",
        "",
    ]
    for req in requests:
        pc_name = (
            pc_by_id.get(req.computer_id).hostname
            if req.computer_id and req.computer_id in pc_by_id
            else ""
        )
        title = (req.title or f"Заявка {req.id}").strip()
        ticket_no = req.ticket_no or req.id
        tickets_parts.append(f"## #{ticket_no} — {title}")
        tickets_parts.append("")
        for item in (
            _line("request_id", req.id),
            _line("Hostname", pc_name),
            _line("computer_id", req.computer_id),
            _line("Статус", _label(_STATUS_LABELS, req.status)),
            _line("Приоритет", _label(_PRIORITY_LABELS, req.priority)),
            _line("Категория", req.category),
            _line("Заявитель", req.requester_name),
            _line("Локация", req.location),
            _line("Открыта", _fmt_dt(req.opened_at or req.created_at)),
            _line("Закрыта / план", _fmt_dt(req.closed_at or req.planned_close_at)),
            _line("Описание", (req.description or "").strip()[:800] or None),
        ):
            if item:
                tickets_parts.append(item)
        tickets_parts.append("")

    users_parts = [
        f"# Пользователи CORAX (снимок {generated_at})",
        "",
        "Сотрудник панели → закреплённые ПК → установленное ПО. Без паролей и токенов.",
        "",
    ]
    pcs_by_user: dict[int, list[Computer]] = defaultdict(list)
    for pc in computers:
        if pc.assigned_user_id is not None:
            pcs_by_user[int(pc.assigned_user_id)].append(pc)

    for u in sorted(users.values(), key=lambda x: (x.full_name or x.username or "").lower()):
        name = (u.full_name or "").strip() or u.username
        users_parts.append(f"## {name} (user_id={u.id})")
        users_parts.append("")
        for item in (
            _line("Логин", u.username),
            _line("Email", u.email),
            _line("Роль", u.role),
            _line("Активен", "да" if u.is_active else "нет"),
        ):
            if item:
                users_parts.append(item)
        owned = pcs_by_user.get(int(u.id)) or []
        if owned:
            users_parts.append(f"- **ПК в ответственности ({len(owned)}):**")
            for pc in sorted(owned, key=lambda x: (x.hostname or "").lower()):
                users_parts.append(f"  - {pc.hostname} (computer_id={pc.id})")
                if getattr(pc, "ip_address", None):
                    users_parts.append(f"    - IP: {pc.ip_address}")
                sw_list = sorted(
                    (x for x in (pc.software or []) if (x.name or "").strip()),
                    key=lambda x: x.name.lower(),
                )
                if sw_list:
                    preview = ", ".join(
                        (s.name + (f" {s.version}" if (s.version or "").strip() else "")).strip()
                        for s in sw_list[:25]
                    )
                    more = f" … ещё {len(sw_list) - 25}" if len(sw_list) > 25 else ""
                    users_parts.append(f"    - ПО ({len(sw_list)}): {preview}{more}")
        else:
            users_parts.append("- **ПК в ответственности:** нет")
        users_parts.append("")

    # --- Статистика ПО: программа → хосты (удобно для аналитики «у кого стоит») ---
    app_hosts: dict[str, list[str]] = defaultdict(list)
    app_versions: dict[str, Counter[str]] = defaultdict(Counter)
    for pc in computers:
        host = (pc.hostname or f"id-{pc.id}").strip()
        seen_on_pc: set[str] = set()
        for s in pc.software or []:
            name = (s.name or "").strip()
            if not name or name.lower() in seen_on_pc:
                continue
            seen_on_pc.add(name.lower())
            app_hosts[name].append(host)
            ver = (s.version or "").strip() or "неизвестно"
            app_versions[name][ver] += 1

    stats_parts = [
        f"# Статистика установленного ПО CORAX (снимок {generated_at})",
        "",
        "Каждая секция — одна программа: число ПК и список hostname. "
        "Используй для вопросов «у кого стоит / не стоит».",
        "",
        f"Уникальных программ: **{len(app_hosts)}**.",
        "",
    ]
    for app_name in sorted(app_hosts.keys(), key=lambda n: (-len(app_hosts[n]), n.lower())):
        hosts = sorted(app_hosts[app_name], key=str.lower)
        stats_parts.append(f"## {app_name}")
        stats_parts.append("")
        stats_parts.append(f"- Установок (ПК): **{len(hosts)}**")
        vers = app_versions.get(app_name) or Counter()
        if vers:
            top = ", ".join(f"{v} ({c})" for v, c in vers.most_common(8))
            stats_parts.append(f"- Версии: {top}")
        # Не раздувать чанк тысячами хостов — режем с пометкой
        show = hosts[:80]
        stats_parts.append("- ПК: " + ", ".join(show) + (f" … ещё {len(hosts) - 80}" if len(hosts) > 80 else ""))
        stats_parts.append("")

    # --- Сеть ---
    network_devices: list[NetworkDevice] = data.get("network_devices") or []
    network_links: list[NetworkLink] = data.get("network_links") or []
    role_c: Counter[str] = Counter()
    type_c: Counter[str] = Counter()
    for dev in network_devices:
        role_c[_device_role(dev)] += 1
        type_c[(dev.device_type or "unknown").strip() or "unknown"] += 1

    network_parts = [
        f"# Сетевое оборудование CORAX (снимок {generated_at})",
        "",
        f"Всего устройств: **{len(network_devices)}**. Связей на карте: **{len(network_links)}**.",
        "",
        "## Сводка по ролям",
        "",
        *(_counter_lines(role_c) if network_devices else ["- (сетевых устройств в базе нет)"]),
        "",
        "## Сводка по типам",
        "",
        *(_counter_lines(type_c) if network_devices else ["- (нет)"]),
        "",
    ]
    # Группы шлюз / DNS в начале файла — удобно для RAG
    for role_key, role_title in (("gateway", "Шлюзы (gateway)"), ("dns", "DNS-серверы")):
        group = [d for d in network_devices if _device_role(d) == role_key]
        network_parts.append(f"## {role_title}")
        network_parts.append("")
        if not group:
            network_parts.append("- (нет)")
            network_parts.append("")
            continue
        for dev in group:
            title = (dev.hostname or dev.sys_name or dev.ip_address or f"net-{dev.id}").strip()
            network_parts.append(
                f"- **{title}** — IP `{dev.ip_address or '—'}`"
                + (f", vendor {dev.vendor}" if (dev.vendor or "").strip() else "")
            )
        network_parts.append("")

    if not network_devices:
        network_parts.append("(карточек устройств нет)")
        network_parts.append("")
    for dev in network_devices:
        title = (dev.hostname or dev.sys_name or dev.ip_address or f"net-{dev.id}").strip()
        role = _device_role(dev)
        network_parts.append(f"## {title} (network_id={dev.id})")
        network_parts.append("")
        for item in (
            _line("IP", dev.ip_address),
            _line("Hostname", dev.hostname),
            _line("sysName", dev.sys_name),
            _line("Роль", role),
            _line("Тип", dev.device_type),
            _line("Vendor", dev.vendor),
            _line("Локация", dev.location),
            _line("SNMP", dev.snmp_status),
            _line("Источник", dev.source),
            _line("Последний опрос", _fmt_dt(dev.last_snmp_at or dev.last_seen_at)),
            _line("Описание", (dev.sys_descr or "").strip()[:400] or None),
            _line("Заметки", (dev.notes or "").strip()[:300] or None),
        ):
            if item:
                network_parts.append(item)
        # Краткая структура интерфейсов / соседей без раздувания
        try:
            raw_ifaces = getattr(dev, "interfaces_json", None)
            ifaces = json.loads(raw_ifaces) if raw_ifaces else []
        except (TypeError, json.JSONDecodeError):
            ifaces = []
        if isinstance(ifaces, list) and ifaces:
            network_parts.append(f"- **Интерфейсов (SNMP):** {len(ifaces)}")
            preview = []
            for iface in ifaces[:12]:
                if not isinstance(iface, dict):
                    continue
                name = str(iface.get("name") or iface.get("ifDescr") or iface.get("ifName") or "").strip()
                status = str(iface.get("oper_status") or iface.get("status") or "").strip()
                bit = name or "?"
                if status:
                    bit += f" [{status}]"
                preview.append(bit)
            if preview:
                network_parts.append("- Интерфейсы (фрагмент): " + ", ".join(preview))
        try:
            raw_neigh = getattr(dev, "neighbors_json", None)
            neigh = json.loads(raw_neigh) if raw_neigh else []
        except (TypeError, json.JSONDecodeError):
            neigh = []
        if isinstance(neigh, list) and neigh:
            network_parts.append(f"- **Соседей (LLDP/CDP):** {len(neigh)}")
        network_parts.append("")

    if network_links:
        network_parts.append("## Связи (карта)")
        network_parts.append("")
        link_type_c: Counter[str] = Counter(
            (ln.link_type or "unknown").strip() or "unknown" for ln in network_links
        )
        network_parts.extend(_counter_lines(link_type_c))
        network_parts.append("")
        for ln in network_links[:120]:
            network_parts.append(
                f"- {ln.from_type}:{ln.from_id} → {ln.to_type}:{ln.to_id}"
                f" ({ln.link_type or 'link'}"
                + (f", {ln.local_port}↔{ln.remote_port}" if ln.local_port or ln.remote_port else "")
                + ")"
            )
        if len(network_links) > 120:
            network_parts.append(f"- … ещё {len(network_links) - 120} связей")
        network_parts.append("")

    return {
        CORAX_COMPUTERS_MD: "\n".join(computers_parts).strip() + "\n",
        CORAX_HARDWARE_MD: "\n".join(hardware_parts).strip() + "\n",
        CORAX_SOFTWARE_MD: "\n".join(software_parts).strip() + "\n",
        CORAX_SOFTWARE_STATS_MD: "\n".join(stats_parts).strip() + "\n",
        CORAX_PARK_STATS_MD: _build_park_stats_md(data, generated_at=generated_at),
        CORAX_PRINTERS_MD: "\n".join(printers_parts).strip() + "\n",
        CORAX_NETWORK_MD: "\n".join(network_parts).strip() + "\n",
        CORAX_TICKETS_MD: "\n".join(tickets_parts).strip() + "\n",
        CORAX_USERS_MD: "\n".join(users_parts).strip() + "\n",
        CORAX_TAGS_MD: "\n".join(tags_parts).strip() + "\n",
    }


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
    """Снимок для WikiRAG: README + доменные MD (основной индекс)."""
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    bundle = {CORAX_README_FILENAME: _build_readme(data, generated_at=now)}
    bundle.update(_build_md_documents(data, generated_at=now))
    return bundle


def _trim_csv_rows(csv_text: str, max_rows: int) -> str:
    lines = csv_text.strip().split("\n")
    if len(lines) <= max_rows + 1:
        return csv_text
    return "\n".join(lines[: max_rows + 1]) + f"\n… ещё {len(lines) - max_rows - 1} строк"


def _question_terms(question: str) -> set[str]:
    return {
        word.lower()
        for word in re.findall(r"[a-zа-яё0-9_-]{3,}", (question or "").lower())
        if word.lower() not in {"что", "как", "где", "это", "для", "про", "или", "все", "есть", "какие"}
    }


def _relevant_csv_rows(csv_text: str, question: str, max_rows: int) -> str:
    """CSV с заголовком и строками, связанными с hostname/тегом/словами вопроса."""
    lines = csv_text.strip().splitlines()
    if len(lines) <= 1:
        return csv_text
    terms = _question_terms(question)
    matched = [line for line in lines[1:] if not terms or any(term in line.lower() for term in terms)]
    chosen = (matched or lines[1:])[:max_rows]
    extra = max(0, len(matched or lines[1:]) - len(chosen))
    result = "\n".join([lines[0], *chosen])
    return result + (f"\n… ещё {extra} релевантных строк" if extra else "")


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


def _is_weakest_pc_question(question: str) -> bool:
    low = (question or "").lower()
    keys = (
        "слаб",
        "слабые",
        "слабый",
        "худш",
        "топ ",
        "топ-",
        "самых слаб",
        "мало ram",
        "мало озу",
        "weak",
        "oldest",
    )
    return any(k in low for k in keys)


def build_weakest_pcs_table(data: dict[str, Any], *, limit: int = 8) -> str:
    """Короткий ранжированный список слабых ПК — для RAG, не простыня hostname."""
    computers: list[Computer] = data.get("computers") or []
    if not computers:
        return "Слабые ПК: в снимке нет компьютеров."

    def score(pc: Computer) -> tuple[float, int, str]:
        ram = _ram_gb_value(pc.ram_gb)
        ram_s = float(ram) if ram is not None else 99.0
        tier = _os_upgrade_tier(pc.os_name, pc.os_version)  # ниже = старее ОС
        return (ram_s, tier, (pc.hostname or "").lower())

    ranked = sorted(computers, key=score)[: max(3, min(limit, 12))]
    lines = [f"### Топ-{len(ranked)} слабых ПК (меньше RAM / старее ОС — выше в списке)"]
    for i, pc in enumerate(ranked, 1):
        ram = _ram_gb_value(getattr(pc, "ram_gb", None))
        ram_s = f"{ram:g} ГБ" if ram is not None else "RAM н/д"
        os_name = (getattr(pc, "os_name", None) or "—").strip()
        os_ver = (getattr(pc, "os_version", None) or "").strip()
        os_s = f"{os_name} {os_ver}".strip()
        cpu_s = (getattr(pc, "cpu", None) or "—").strip()
        if len(cpu_s) > 48:
            cpu_s = cpu_s[:45] + "…"
        host = (getattr(pc, "hostname", None) or f"id-{getattr(pc, 'id', '?')}").strip()
        lines.append(f"{i}. {host} — ОС: {os_s}; RAM: {ram_s}; CPU: {cpu_s}")
    return "\n".join(lines)


def build_inventory_analysis_hint(data: dict[str, Any], question: str) -> str:
    if not _is_hardware_question(question):
        return ""
    computers: list[Computer] = data["computers"]
    if not computers:
        return "## Аналитика парка\nПК в CORAX не найдены."

    # Вопросы «топ слабых» — только компактный рейтинг, без простыни hostname.
    if _is_weakest_pc_question(question):
        return build_weakest_pcs_table(data, limit=8)

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
    for label, cnt in sorted(os_counts.items(), key=lambda x: (-x[1], x[0]))[:10]:
        lines.append(f"- {label}: {cnt}")

    def _fmt_hosts(hosts: list[str], limit: int = 10) -> str:
        if not hosts:
            return "(нет)"
        uniq = sorted({h for h in hosts if h})
        if len(uniq) <= limit:
            return ", ".join(uniq)
        return ", ".join(uniq[:limit]) + f" … и ещё {len(uniq) - limit}"

    lines += [
        "",
        f"### Кандидаты на миграцию (устаревшая ОС): {len(set(need_upgrade))}",
        _fmt_hosts(need_upgrade, 10),
        "",
        f"### Мало RAM (<4 ГБ): {len(set(low_ram))}",
        _fmt_hosts(low_ram, 10),
        "",
        f"### Приоритет Win10 (старая ОС + RAM≥4): {len(set(good_candidates))}",
        _fmt_hosts(good_candidates, 10),
        "",
        build_weakest_pcs_table(data, limit=5),
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


def build_fast_software_answer(data: dict[str, Any], question: str) -> str:
    """Точный ответ без LLM для «у кого есть/нет <ПО>»."""
    low = question.lower()
    asks_absent = any(marker in low for marker in ("нет ", "не установлен", "отсутств", "без "))
    asks_inventory = any(marker in low for marker in ("у кого", "сколько", "какие", "есть ли", "установ"))
    if not asks_inventory:
        return ""
    terms = _question_terms(question)
    ignored = {
        "программа", "программы", "установлена", "установлено", "установлен",
        "сколько", "кого", "какие", "какой", "нет", "без",
    }
    terms -= ignored
    if not terms:
        return ""
    computers: list[Computer] = data.get("computers") or []
    if not computers:
        return ""
    matching: list[str] = []
    for pc in computers:
        names = " ".join((s.name or "").lower() for s in (pc.software or []))
        if all(term in names for term in terms):
            matching.append(pc.hostname)
    # If a full word such as "web" is absent in every entry, do not manufacture
    # a confident answer to an unrelated software question.
    if not matching and not any(term in " ".join((s.name or "").lower() for pc in computers for s in (pc.software or [])) for term in terms):
        return ""
    selected = sorted(set(computers[i].hostname for i in range(len(computers)) if (computers[i].hostname in matching) != asks_absent))
    subject = " ".join(sorted(terms))
    limit = 40
    shown = ", ".join(selected[:limit]) or "—"
    suffix = f" … и ещё {len(selected) - limit}" if len(selected) > limit else ""
    verb = "не установлено" if asks_absent else "установлено"
    return (
        f"**{subject}: {verb} у {len(selected)} из {len(computers)} ПК.**\n\n"
        f"Hostname: {shown}{suffix}\n\n"
        "Проверено по последним данным инвентаризации CORAX."
    )


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
    # Для ОС/железа даём модели достаточно строк для анализа, но не полный dump (скорость 3B).
    if _is_hardware_question(question):
        if n_pc > 120:
            return "compact"
        if n_pc > 40:
            return "medium"
        return "medium"
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
    # CSV-таблицы только для компактных live-выписок в промпт (не пишутся в WikiRAG).
    tables = _build_csv_tables(data)
    readme = _build_readme(
        data, generated_at=datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    )
    n_pc = len(data["computers"])
    hardware = _is_hardware_question(question)
    from app.wikirag_lm import classify_wikirag_question

    focus = classify_wikirag_question(question)
    hint = build_inventory_analysis_hint(data, question) if hardware else ""

    # Для ПО и заявок не передаём универсальную сводку всего парка: это
    # уменьшает input tokens и оставляет модели только тематические строки.
    if focus in ("software", "tickets"):
        filename = "CORAX_ПО.csv" if focus == "software" else "CORAX_заявки.csv"
        label = "установленное ПО" if focus == "software" else "заявки"
        row_limit = 40 if level in ("medium", "full") else 18
        table = _relevant_csv_rows(tables[filename], question, row_limit)
        text = (
            f"CORAX: {n_pc} ПК. Тема вопроса: {label}. Ключ связи: computer_id, hostname.\n\n"
            f"### {filename}\n```csv\n{table.strip()}\n```"
        )
        if len(text) > max_chars:
            text = text[: max(0, max_chars - 24)].rstrip() + "\n… [контекст обрезан]"
        return text

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
                f"Полные справочники — в файлах CORAX_*.md (документы WikiRAG).\n"
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
                else _trim_csv_rows(tables["CORAX_компьютеры.csv"], pc_rows).strip()
            )
            + "\n```",
            "### CORAX_теги_пк.csv\n```csv\n"
            + _trim_csv_rows(tables["CORAX_теги_пк.csv"], 60).strip()
            + "\n```",
        ]
        if not hardware:
            parts.append("(ПО и заявки — в CORAX_ПО.md / CORAX_заявки.md в документах.)")
        text = "\n\n".join(parts)
    elif level == "medium":
        parts = [
            readme.strip()[:1200],
            "### CORAX_компьютеры.csv\n```csv\n"
            + _trim_csv_rows(tables["CORAX_компьютеры.csv"], min(n_pc, 80)).strip()
            + "\n```",
            "### CORAX_теги_пк.csv\n```csv\n" + tables["CORAX_теги_пк.csv"].strip() + "\n```",
            "### CORAX_ПО.csv\n```csv\n" + _trim_csv_rows(tables["CORAX_ПО.csv"], 50).strip() + "\n```",
        ]
        text = "\n\n".join(parts)
    else:
        sw_limit = 80 if n_pc > 25 else 200
        req_limit = 60 if n_pc > 25 else 120
        parts = [
            readme.strip()[:1500],
            "### CORAX_компьютеры.csv\n```csv\n" + tables["CORAX_компьютеры.csv"].strip() + "\n```",
            "### CORAX_теги_пк.csv\n```csv\n" + tables["CORAX_теги_пк.csv"].strip() + "\n```",
            "### CORAX_ПО.csv\n```csv\n" + _trim_csv_rows(tables["CORAX_ПО.csv"], sw_limit).strip() + "\n```",
            "### CORAX_заявки.csv\n```csv\n"
            + _trim_csv_rows(tables["CORAX_заявки.csv"], req_limit).strip()
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
        "network_devices": len(data.get("network_devices") or []),
        "files": len(bundle),
        "chars": total_chars,
    }
    return bundle, stats


async def build_corax_knowledge_markdown(db: AsyncSession) -> tuple[str, dict[str, int]]:
    """Совместимость: один большой текст (все доменные MD подряд)."""
    bundle, stats = await build_corax_knowledge_bundle(db)
    parts = [bundle[CORAX_README_FILENAME]]
    for name in CORAX_BUNDLE_FILENAMES:
        if name == CORAX_README_FILENAME:
            continue
        parts.append(f"# Документ: {name}\n\n{bundle[name].strip()}\n")
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
