from __future__ import annotations

import json
import logging
import math
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from app.models import Computer, DiskVolume, InstalledSoftware, RiskFindingAck, RiskSnapshot, ServiceRequest
from app.risk_schemas import (
    RiskCategorySummary,
    RiskComputer,
    RiskFinding,
    RiskOverview,
)


_CATEGORY_LABELS = {
    "security": "Защита",
    "lifecycle": "Жизненный цикл",
    "reliability": "Надёжность",
    "capacity": "Ресурсы",
    "coverage": "Качество данных",
    "operations": "Эксплуатация",
}
_SEVERITY_ORDER = {"critical": 4, "high": 3, "medium": 2, "low": 1}
_OVERVIEW_CACHE: tuple[float, tuple, RiskOverview] | None = None
_OVERVIEW_CACHE_SECONDS = 30.0
_SNAPSHOT_MIN_INTERVAL = timedelta(hours=1)
_SNAPSHOT_KEEP = 180
logger = logging.getLogger(__name__)
_ANTIVIRUS_SOFTWARE_TOKENS = (
    "defender",
    "dr.web",
    "dr web",
    "kaspersky",
    "eset",
    "symantec",
    "sophos",
    "avast",
    "avg antivirus",
    "bitdefender",
    "mcafee",
    "trend micro",
    "crowdstrike",
    "sentinelone",
)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _payload(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _number(value: Any) -> float | None:
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def _parse_inventory_date(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    normalized = raw.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    for pattern in ("%m/%d/%Y", "%d.%m.%Y", "%Y/%m/%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, pattern).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _module_status(extended: dict[str, Any], name: str) -> str:
    result = _dict(_dict(extended.get("modules_result")).get(name))
    return str(result.get("status") or "").strip().lower()


def _antivirus_products(extended: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        _dict(item)
        for item in _list(extended.get("antivirus"))
        if str(_dict(item).get("kind") or "").strip().lower() != "firewall"
    ]


def _decode_antivirus_product_state(value: Any) -> tuple[bool | None, bool | None]:
    """Decode Windows SecurityCenter2 productState: provider | state | signatures."""
    try:
        numeric = int(str(value).strip(), 0)
    except (TypeError, ValueError):
        return None, None
    if numeric < 0 or numeric > 0xFFFFFF:
        return None, None
    encoded = f"{numeric:06x}"
    state = int(encoded[2:4], 16)
    signatures = int(encoded[4:6], 16)
    enabled = state in {0x10, 0x11}
    up_to_date = signatures == 0x00
    return enabled, up_to_date


def antivirus_posture(
    computer: Computer,
    *,
    security_software: list[str] | tuple[str, ...] = (),
) -> tuple[str, str]:
    """Return protected | attention | unknown and a stable reason."""
    extended = _dict(_payload(computer.raw_payload).get("extended"))
    products = _antivirus_products(extended)
    if products:
        decoded = [_decode_antivirus_product_state(item.get("product_state")) for item in products]
        if any(enabled is True and up_to_date is not False for enabled, up_to_date in decoded):
            return "protected", "security-center"
        if any(enabled is True and up_to_date is False for enabled, up_to_date in decoded):
            return "attention", "outdated"
        if decoded and all(enabled is False for enabled, _ in decoded):
            return "attention", "disabled"
        return "protected", "security-center"

    software_low = " | ".join(security_software).lower()
    if any(token in software_low for token in _ANTIVIRUS_SOFTWARE_TOKENS):
        return "protected", "software-fallback"

    module_status = _module_status(extended, "antivirus")
    if module_status in {"ok", "degraded"}:
        return "attention", "missing"
    return "unknown", "not-collected"


def _level(score: int) -> str:
    if score >= 60:
        return "critical"
    if score >= 35:
        return "high"
    if score >= 15:
        return "medium"
    return "healthy"


def _finding(
    *,
    computer: Computer,
    rule: str,
    category: str,
    severity: str,
    score: int,
    title: str,
    description: str,
    recommendation: str,
    evidence: str | None = None,
) -> RiskFinding:
    return RiskFinding(
        id=f"{computer.id}:{rule}",
        computer_id=computer.id,
        hostname=computer.hostname or f"PC #{computer.id}",
        category=category,
        severity=severity,
        score=score,
        title=title,
        description=description,
        recommendation=recommendation,
        evidence=evidence,
        status="open",
    )


def evaluate_computer(
    computer: Computer,
    *,
    volumes: list[DiskVolume],
    overdue_tickets: int,
    now: datetime,
    security_software: list[str] | tuple[str, ...] = (),
) -> list[RiskFinding]:
    findings: list[RiskFinding] = []
    payload = _payload(computer.raw_payload)
    extended = _dict(payload.get("extended"))

    def add(**kwargs: Any) -> None:
        findings.append(_finding(computer=computer, **kwargs))

    last_report = _utc(computer.last_report_at)
    if last_report is None:
        add(
            rule="agent-never",
            category="coverage",
            severity="critical",
            score=35,
            title="Компьютер ещё не присылал полный отчёт",
            description="Состояние защиты и оборудования невозможно подтвердить.",
            recommendation="Запустите актуальный CORAX Agent и проверьте его токен и адрес сервера.",
        )
    else:
        report_age = max(0, (now - last_report).days)
        if report_age >= 30:
            add(
                rule="agent-stale-critical",
                category="coverage",
                severity="high",
                score=24,
                title="Данные не обновлялись больше месяца",
                description=f"Последний отчёт получен {report_age} дн. назад.",
                recommendation="Проверьте задачу планировщика, доступность API и состояние агента.",
                evidence=f"{report_age} дней",
            )
        elif report_age >= 7:
            add(
                rule="agent-stale",
                category="coverage",
                severity="medium",
                score=12,
                title="Отчёт агента устарел",
                description=f"Инвентаризация не обновлялась {report_age} дн.",
                recommendation="Запустите агент повторно или проверьте расписание.",
                evidence=f"{report_age} дней",
            )

    os_name = (computer.os_name or "").strip()
    os_low = os_name.lower()
    if any(token in os_low for token in ("windows 7", "windows 8", "windows 8.1")):
        add(
            rule="os-eol-critical",
            category="lifecycle",
            severity="critical",
            score=35,
            title="Операционная система снята с поддержки",
            description=f"{os_name or 'Эта ОС'} больше не получает стандартные обновления безопасности.",
            recommendation="Запланируйте миграцию на поддерживаемую версию Windows.",
            evidence=os_name,
        )
    elif "windows 10" in os_low:
        add(
            rule="os-eol-win10",
            category="lifecycle",
            severity="high",
            score=24,
            title="Windows 10 завершила общий жизненный цикл",
            description="После октября 2025 года стандартная поддержка Windows 10 завершена.",
            recommendation="Проверьте совместимость и подготовьте переход на Windows 11 или ESU.",
            evidence=os_name,
        )
    elif any(token in os_low for token in ("server 2008", "server 2012")):
        add(
            rule="server-eol",
            category="lifecycle",
            severity="critical",
            score=35,
            title="Серверная ОС снята с поддержки",
            description=f"{os_name} требует миграции или документированной программы расширенных обновлений.",
            recommendation="Подготовьте обновление серверной ОС и резервный план.",
            evidence=os_name,
        )

    if computer.ram_gb is not None and computer.ram_gb < 4:
        add(
            rule="ram-critical-low",
            category="capacity",
            severity="high",
            score=16,
            title="Критически мало оперативной памяти",
            description=f"Установлено только {computer.ram_gb:g} ГБ RAM.",
            recommendation="Проверьте возможность увеличения памяти или замены устройства.",
            evidence=f"{computer.ram_gb:g} ГБ",
        )
    elif computer.ram_gb is not None and computer.ram_gb < 8:
        add(
            rule="ram-low",
            category="capacity",
            severity="low",
            score=5,
            title="Малый объём оперативной памяти",
            description=f"Установлено {computer.ram_gb:g} ГБ RAM — это ограничивает современные приложения.",
            recommendation="Учтите устройство в плане модернизации.",
            evidence=f"{computer.ram_gb:g} ГБ",
        )

    av_posture, av_reason = antivirus_posture(
        computer,
        security_software=security_software,
    )
    if av_posture == "attention" and av_reason == "missing":
        add(
            rule="antivirus-missing",
            category="security",
            severity="critical",
            score=32,
            title="Антивирус не обнаружен",
            description="Агент опросил Windows Security Center, но не нашёл зарегистрированной защиты.",
            recommendation="Проверьте Microsoft Defender или корпоративный антивирус и актуальность его баз.",
        )
    elif av_posture == "attention" and av_reason == "disabled":
        add(
            rule="antivirus-disabled",
            category="security",
            severity="critical",
            score=30,
            title="Антивирус зарегистрирован, но защита отключена",
            description="Windows Security Center сообщает, что продукт не находится в активном состоянии.",
            recommendation="Включите защиту в реальном времени и проверьте централизованную политику.",
        )
    elif av_posture == "attention" and av_reason == "outdated":
        add(
            rule="antivirus-outdated",
            category="security",
            severity="high",
            score=18,
            title="Антивирусные базы требуют обновления",
            description="Windows Security Center сообщает об устаревшем состоянии сигнатур.",
            recommendation="Запустите обновление баз и проверьте доступ к серверу обновлений.",
        )
    elif av_posture == "unknown":
        add(
            rule="antivirus-unknown",
            category="coverage",
            severity="low",
            score=6,
            title="Состояние антивируса не подтверждено",
            description="Профиль агента не собрал Security Center, а известный продукт не найден в списке ПО.",
            recommendation="Запустите полный профиль CORAX Agent для проверки защиты.",
        )

    bitlocker = [_dict(item) for item in _list(extended.get("bitlocker"))]
    system_volumes = [
        item for item in bitlocker if str(item.get("mount_point") or "").strip().upper() in {"C:", "C:\\"}
    ]
    system_volume_protected = any(
        _truthy(
            item.get("protected")
            if "protected" in item
            else item.get("protection_status")
        )
        for item in system_volumes
    )
    if system_volumes and not system_volume_protected:
        add(
            rule="bitlocker-system",
            category="security",
            severity="high",
            score=22,
            title="Системный диск не защищён BitLocker",
            description="При потере устройства данные системного тома можно прочитать вне Windows.",
            recommendation="Включите BitLocker и сохраните ключ восстановления в принятом хранилище.",
            evidence="C:",
        )

    if extended.get("secure_boot_enabled") is False:
        add(
            rule="secure-boot-disabled",
            category="security",
            severity="high",
            score=18,
            title="Secure Boot отключён",
            description="Windows сообщает, что проверка доверенной загрузки отключена.",
            recommendation="Проверьте режим UEFI и включите Secure Boot после проверки совместимости.",
        )

    if extended.get("pending_reboot") is True:
        add(
            rule="pending-reboot",
            category="operations",
            severity="medium",
            score=8,
            title="Для завершения обслуживания нужна перезагрузка",
            description="Обновление или системная операция ожидает перезапуска Windows.",
            recommendation="Согласуйте окно обслуживания и перезагрузите компьютер.",
        )

    last_hotfix = _parse_inventory_date(extended.get("last_hotfix_on"))
    if last_hotfix is None:
        patch_dates = [
            parsed
            for item in _list(extended.get("patches"))
            if (parsed := _parse_inventory_date(_dict(item).get("installed_on"))) is not None
        ]
        last_hotfix = max(patch_dates, default=None)
    if last_hotfix is not None:
        patch_age = max(0, (now - last_hotfix).days)
        if patch_age >= 120:
            add(
                rule="patches-stale",
                category="security",
                severity="high",
                score=18,
                title="Давно не устанавливались обновления Windows",
                description=f"Последнее обнаруженное обновление установлено {patch_age} дн. назад.",
                recommendation="Проверьте Windows Update, WSUS и политики обслуживания.",
                evidence=f"{patch_age} дней",
            )

    tpm = _dict(extended.get("tpm"))
    if tpm and tpm.get("present") is False:
        add(
            rule="tpm-missing",
            category="security",
            severity="medium",
            score=12,
            title="TPM не обнаружен",
            description="Аппаратный корень доверия отсутствует или отключён в UEFI.",
            recommendation="Проверьте TPM/PTT/fTPM в UEFI и совместимость оборудования.",
        )
    elif tpm.get("present") is True and tpm.get("enabled") is False:
        add(
            rule="tpm-disabled",
            category="security",
            severity="medium",
            score=10,
            title="TPM присутствует, но отключён",
            description="Модуль найден, однако Windows сообщает, что он не активирован.",
            recommendation="Активируйте TPM в UEFI после проверки политики компании.",
        )

    for volume in volumes:
        used = volume.used_percent
        if used is None:
            continue
        if used >= 95:
            add(
                rule=f"volume-critical-{volume.id}",
                category="capacity",
                severity="critical",
                score=24,
                title=f"На диске {volume.mount} почти нет места",
                description=f"Занято {used}% тома; обновления и приложения могут перестать работать.",
                recommendation="Освободите место или увеличьте объём тома.",
                evidence=f"{used}%",
            )
        elif used >= 85:
            add(
                rule=f"volume-warning-{volume.id}",
                category="capacity",
                severity="medium",
                score=10,
                title=f"Заканчивается место на диске {volume.mount}",
                description=f"Использовано {used}% доступного объёма.",
                recommendation="Запланируйте очистку до достижения критического порога.",
                evidence=f"{used}%",
            )

    physical_disks = [_dict(item) for item in _list(extended.get("physical_disks"))]
    unhealthy: list[str] = []
    for disk in physical_disks:
        health = str(disk.get("health_status") or "").strip().lower()
        if health and health not in {"0", "5", "healthy", "ok", "unknown"}:
            unhealthy.append(str(disk.get("friendly_name") or "Физический диск"))
    if unhealthy:
        add(
            rule="physical-disk-health",
            category="reliability",
            severity="critical",
            score=32,
            title="Накопитель сообщает о проблеме",
            description="Windows Storage API вернул состояние, отличное от Healthy.",
            recommendation="Сделайте резервную копию и проведите диагностику накопителя.",
            evidence=", ".join(unhealthy[:3]),
        )

    memory_used = computer.memory_used_percent
    if memory_used is not None and memory_used >= 95:
        add(
            rule="memory-pressure",
            category="capacity",
            severity="high",
            score=16,
            title="Критическая загрузка оперативной памяти",
            description=f"Во время отчёта использовалось {memory_used}% памяти.",
            recommendation="Найдите потребляющие память процессы или увеличьте объём RAM.",
            evidence=f"{memory_used}%",
        )
    elif memory_used is not None and memory_used >= 85:
        add(
            rule="memory-warning",
            category="capacity",
            severity="medium",
            score=8,
            title="Высокая загрузка оперативной памяти",
            description=f"Использовалось {memory_used}% RAM.",
            recommendation="Проверьте устойчивость нагрузки и потребление приложений.",
            evidence=f"{memory_used}%",
        )

    batteries = [_dict(item) for item in _list(extended.get("battery"))]
    weak_batteries = []
    battery_health = _dict(extended.get("battery_health"))
    reported_health = _number(battery_health.get("health_percent"))
    if reported_health is not None and reported_health < 55:
        weak_batteries.append(int(round(reported_health)))
    for battery in batteries:
        design = _number(battery.get("design_capacity"))
        full = _number(battery.get("full_charge_capacity"))
        if design and full is not None and design > 0 and full / design < 0.55:
            weak_batteries.append(int(round((full / design) * 100)))
    if weak_batteries:
        add(
            rule="battery-wear",
            category="reliability",
            severity="medium",
            score=10,
            title="Батарея заметно изношена",
            description=f"Остаточная ёмкость около {min(weak_batteries)}% от проектной.",
            recommendation="Запланируйте замену батареи и проверьте время автономной работы.",
            evidence=f"{min(weak_batteries)}%",
        )

    local_admins = _list(extended.get("local_admins"))
    if len(local_admins) > 5:
        add(
            rule="local-admins-many",
            category="security",
            severity="medium",
            score=10,
            title="Слишком много локальных администраторов",
            description=f"В локальной группе администраторов обнаружено {len(local_admins)} записей.",
            recommendation="Проверьте состав группы и удалите неиспользуемые привилегированные учётные записи.",
            evidence=str(len(local_admins)),
        )

    network = _dict(extended.get("network"))
    wifi_rows = _list(network.get("wifi")) + _list(extended.get("wifi"))
    open_wifi = [
        _dict(item)
        for item in wifi_rows
        if "open" in str(_dict(item).get("authentication") or "").strip().lower()
    ]
    if open_wifi:
        add(
            rule="wifi-open",
            category="security",
            severity="high",
            score=20,
            title="Обнаружено подключение к открытой Wi‑Fi сети",
            description="Аутентификация беспроводной сети отмечена как Open.",
            recommendation="Используйте защищённую корпоративную сеть WPA2/WPA3.",
        )

    module_results = _dict(extended.get("modules_result"))
    degraded = [
        name
        for name, result in module_results.items()
        if str(_dict(result).get("status") or "").lower() in {"degraded", "error"}
    ]
    if len(degraded) >= 3:
        add(
            rule="collection-degraded",
            category="coverage",
            severity="low",
            score=6,
            title="Часть данных собрана не полностью",
            description=f"Модули с ограничениями: {', '.join(degraded[:5])}.",
            recommendation="Проверьте права агента, WMI и поддержку функций этой версией Windows.",
        )

    if overdue_tickets > 0:
        add(
            rule="tickets-overdue",
            category="operations",
            severity="medium" if overdue_tickets == 1 else "high",
            score=min(18, 7 + overdue_tickets * 3),
            title="Есть просроченные заявки по этому компьютеру",
            description=f"Количество просроченных активных заявок: {overdue_tickets}.",
            recommendation="Проверьте блокирующие причины и обновите срок или статус заявок.",
            evidence=str(overdue_tickets),
        )

    return sorted(
        findings,
        key=lambda item: (-_SEVERITY_ORDER.get(item.severity, 0), -item.score, item.title),
    )


def invalidate_risk_overview_cache() -> None:
    global _OVERVIEW_CACHE
    _OVERVIEW_CACHE = None


async def _risk_stamp(db: AsyncSession) -> tuple:
    computer_n, last_report = (
        await db.execute(select(func.count(), func.max(Computer.last_report_at)))
    ).one()
    ack_n, ack_updated = (
        await db.execute(
            select(func.count(), func.max(RiskFindingAck.updated_at)).select_from(RiskFindingAck)
        )
    ).one()
    return (int(computer_n or 0), str(last_report), int(ack_n or 0), str(ack_updated))


def _utc_dt(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


async def _maybe_record_snapshot(db: AsyncSession, overview: RiskOverview) -> None:
    last = await db.scalar(select(RiskSnapshot).order_by(RiskSnapshot.created_at.desc()).limit(1))
    now = datetime.now(timezone.utc)
    if last is not None:
        last_at = _utc_dt(last.created_at) or now
        same_score = last.fleet_health_score == overview.fleet_health_score
        same_open = last.findings_open == overview.findings_open
        if same_score and same_open and (now - last_at) < _SNAPSHOT_MIN_INTERVAL:
            return
    db.add(
        RiskSnapshot(
            created_at=now,
            fleet_health_score=overview.fleet_health_score,
            average_risk_score=overview.average_risk_score,
            computers_total=overview.computers_total,
            computers_critical=overview.computers_critical,
            computers_high=overview.computers_high,
            computers_medium=overview.computers_medium,
            computers_healthy=overview.computers_healthy,
            findings_open=overview.findings_open,
        )
    )
    await db.flush()
    extra_ids = list(
        (
            await db.execute(
                select(RiskSnapshot.id).order_by(RiskSnapshot.created_at.desc()).offset(_SNAPSHOT_KEEP)
            )
        )
        .scalars()
        .all()
    )
    if extra_ids:
        await db.execute(delete(RiskSnapshot).where(RiskSnapshot.id.in_(extra_ids)))
    await db.commit()


async def build_risk_overview(db: AsyncSession, *, force: bool = False) -> RiskOverview:
    global _OVERVIEW_CACHE
    now_monotonic = time.monotonic()
    stamp = await _risk_stamp(db)
    cached = _OVERVIEW_CACHE
    if not force and cached and cached[0] > now_monotonic and cached[1] == stamp:
        return cached[2]

    now = datetime.now(timezone.utc)
    computers = list(
        (
            await db.execute(
                select(Computer)
                .options(
                    load_only(
                        Computer.id,
                        Computer.hostname,
                        Computer.ip_address,
                        Computer.os_name,
                        Computer.ram_gb,
                        Computer.memory_used_percent,
                        Computer.last_report_at,
                        Computer.raw_payload,
                    )
                )
                .order_by(Computer.id.asc())
                .limit(5000)
            )
        )
        .scalars()
        .all()
    )
    volumes = list((await db.execute(select(DiskVolume))).scalars().all())
    volumes_by_computer: dict[int, list[DiskVolume]] = defaultdict(list)
    for volume in volumes:
        volumes_by_computer[volume.computer_id].append(volume)

    antivirus_conditions = [
        func.lower(InstalledSoftware.name).like(f"%{token}%")
        for token in _ANTIVIRUS_SOFTWARE_TOKENS
    ]
    security_software_rows = (
        await db.execute(
            select(InstalledSoftware.computer_id, InstalledSoftware.name).where(
                or_(*antivirus_conditions)
            )
        )
    ).all()
    security_software_by_computer: dict[int, list[str]] = defaultdict(list)
    for computer_id, name in security_software_rows:
        security_software_by_computer[int(computer_id)].append(str(name))

    overdue_by_computer: dict[int, int] = defaultdict(int)
    overdue_rows = (
        await db.execute(
            select(ServiceRequest.computer_id)
            .where(ServiceRequest.computer_id.is_not(None))
            .where(ServiceRequest.planned_close_at.is_not(None))
            .where(ServiceRequest.planned_close_at < now)
            .where(ServiceRequest.closed_at.is_(None))
            .where(ServiceRequest.status.notin_(["done", "cancelled"]))
        )
    ).all()
    for row in overdue_rows:
        overdue_by_computer[int(row[0])] += 1

    ack_rows = list((await db.execute(select(RiskFindingAck))).scalars().all())
    ack_by_id = {row.finding_id: row for row in ack_rows}

    computer_rows: list[RiskComputer] = []
    all_findings: list[RiskFinding] = []
    category_points: dict[str, int] = defaultdict(int)
    category_computers: dict[str, set[int]] = defaultdict(set)
    category_findings: dict[str, int] = defaultdict(int)
    antivirus_counts: dict[str, int] = defaultdict(int)

    for computer in computers:
        security_software = security_software_by_computer.get(computer.id, [])
        antivirus_status = antivirus_posture(
            computer,
            security_software=security_software,
        )[0]
        antivirus_counts[antivirus_status] += 1
        findings = evaluate_computer(
            computer,
            volumes=volumes_by_computer.get(computer.id, []),
            overdue_tickets=overdue_by_computer.get(computer.id, 0),
            now=now,
            security_software=security_software,
        )
        tagged: list[RiskFinding] = []
        open_findings: list[RiskFinding] = []
        for finding in findings:
            ack = ack_by_id.get(finding.id)
            if ack is not None:
                finding = finding.model_copy(
                    update={"status": ack.status, "action_note": ack.note}
                )
            tagged.append(finding)
            if finding.status == "open":
                open_findings.append(finding)
                category_points[finding.category] += finding.score
                category_computers[finding.category].add(computer.id)
                category_findings[finding.category] += 1
        score = min(100, sum(item.score for item in open_findings))
        all_findings.extend(tagged)
        computer_rows.append(
            RiskComputer(
                id=computer.id,
                hostname=computer.hostname or f"PC #{computer.id}",
                ip_address=computer.ip_address,
                os_name=computer.os_name,
                last_report_at=_utc(computer.last_report_at),
                risk_score=score,
                level=_level(score),
                antivirus_status=antivirus_status,
                finding_count=len(open_findings),
                top_findings=open_findings[:3],
            )
        )

    computer_rows.sort(key=lambda item: (-item.risk_score, item.hostname.lower()))
    status_rank = {"open": 0, "acknowledged": 1, "ignored": 2}
    all_findings.sort(
        key=lambda item: (
            status_rank.get(item.status, 9),
            -_SEVERITY_ORDER.get(item.severity, 0),
            -item.score,
            item.hostname.lower(),
        )
    )
    average = (
        round(sum(item.risk_score for item in computer_rows) / len(computer_rows), 1)
        if computer_rows
        else 0.0
    )
    levels = defaultdict(int)
    for item in computer_rows:
        levels[item.level] += 1
    findings_open = sum(1 for item in all_findings if item.status == "open")
    findings_acknowledged = sum(1 for item in all_findings if item.status == "acknowledged")
    findings_ignored = sum(1 for item in all_findings if item.status == "ignored")

    categories = [
        RiskCategorySummary(
            id=category,
            label=_CATEGORY_LABELS.get(category, category),
            risk_points=category_points[category],
            affected_computers=len(category_computers[category]),
            finding_count=category_findings[category],
        )
        for category in _CATEGORY_LABELS
        if category_findings[category] > 0
    ]
    categories.sort(key=lambda item: (-item.risk_points, item.label))

    overview = RiskOverview(
        generated_at=now,
        fleet_health_score=max(0, min(100, int(round(100 - average)))),
        average_risk_score=average,
        computers_total=len(computer_rows),
        computers_critical=levels["critical"],
        computers_high=levels["high"],
        computers_medium=levels["medium"],
        computers_healthy=levels["healthy"],
        antivirus_protected=antivirus_counts["protected"],
        antivirus_attention=antivirus_counts["attention"],
        antivirus_unknown=antivirus_counts["unknown"],
        findings_total=findings_open,
        findings_open=findings_open,
        findings_acknowledged=findings_acknowledged,
        findings_ignored=findings_ignored,
        categories=categories,
        computers=computer_rows[:250],
        findings=all_findings[:500],
    )
    try:
        await _maybe_record_snapshot(db, overview)
    except Exception:
        logger.exception("Failed to record risk snapshot")
    _OVERVIEW_CACHE = (now_monotonic + _OVERVIEW_CACHE_SECONDS, stamp, overview)
    return overview
