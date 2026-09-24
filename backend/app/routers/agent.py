import json
import re
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.computer_ip import primary_ipv4_from_extended, resolve_computer_ipv4
from app.config import settings
from app.rate_limit import limiter
from app.database import get_db
from app.models import AgentToken, Computer, DiskVolume, InstalledSoftware, Peripheral, User
from app.oem_normalize import normalize_manufacturer, normalize_system_model
from app.peripheral_display import is_noise_peripheral
from app.schemas import AgentInventoryReport
from app.agent_policy import ack_hostname, build_directive
from app.search_index import sync_computer

router = APIRouter(prefix="/agent", tags=["agent"])

_AGENT_TOKEN_PREFIX = "hmac256:"


def _token_matches(left: str, right: str) -> bool:
    if not left or not right or len(left) != len(right):
        return False
    return hmac.compare_digest(left, right)
_PLACEHOLDER_SERIALS = frozenset(
    {
        "",
        "none",
        "n/a",
        "na",
        "null",
        "to be filled by o.e.m.",
        "default string",
        "system serial number",
        "0",
    }
)


def _norm_mac(value: str | None) -> str:
    return re.sub(r"[^0-9A-Fa-f]", "", value or "").upper()


def _usable_serial(value: str | None) -> str:
    s = (value or "").strip()
    if s.lower() in _PLACEHOLDER_SERIALS:
        return ""
    return s


def _guard_agent_identity(existing: Computer, report: AgentInventoryReport) -> None:
    if not bool(getattr(settings, "agent_bind_identity", True)):
        return
    old_mac = _norm_mac(existing.mac_primary)
    new_mac = _norm_mac(report.mac_primary)
    if old_mac and new_mac and old_mac != new_mac:
        raise HTTPException(
            status_code=403,
            detail="Токен агента не может перезаписать этот hostname: MAC не совпадает",
        )
    old_sn = _usable_serial(existing.serial_number)
    new_sn = _usable_serial(report.serial_number)
    if old_sn and new_sn and old_sn.lower() != new_sn.lower():
        raise HTTPException(
            status_code=403,
            detail="Токен агента не может перезаписать этот hostname: серийный номер не совпадает",
        )


def lean_raw_payload_json(dump: dict) -> str:
    """Store inventory JSON without the full software list (normalized table holds rows)."""
    data = dict(dump)
    software_list = data.pop("software", None) or []
    data["software"] = []
    data["software_count"] = len(software_list)
    return json.dumps(data, ensure_ascii=False)


def _hmac_secret(secret: str) -> str:
    key = (settings.agent_token_pepper or settings.secret_key).encode("utf-8")
    return hmac.new(key, secret.encode("utf-8"), hashlib.sha256).hexdigest()


def _save_inbox_json(hostname: str, computer_id: int, raw: str, when: datetime) -> None:
    if not (settings.agent_inbox_dir or "").strip():
        return
    base = Path(settings.agent_inbox_dir)
    if not base.is_absolute():
        base = Path(__file__).resolve().parent.parent.parent / base
    base.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^\w\-.]+", "_", hostname, flags=re.ASCII)[:80] or "pc"
    name = f"{safe}_{when:%Y%m%dT%H%M%S}_{computer_id}.json"
    (base / name).write_text(raw, encoding="utf-8")


def _reported_usernames(extended: dict | None) -> list[str]:
    """Extract domain/local usernames reported by the Windows agent."""
    if not isinstance(extended, dict):
        return []
    candidates: list[str] = []
    system = extended.get("system")
    if isinstance(system, dict) and system.get("primary_user"):
        candidates.append(str(system["primary_user"]))
    sessions = extended.get("sessions")
    if isinstance(sessions, list):
        candidates.extend(str(item.get("username")) for item in sessions if isinstance(item, dict) and item.get("username"))
    normalized: list[str] = []
    for value in candidates:
        name = value.strip()
        if "\\" in name:
            name = name.rsplit("\\", 1)[-1]
        if "@" in name:
            name = name.split("@", 1)[0]
        name = name.strip().lower()
        if name and name not in normalized:
            normalized.append(name)
    return normalized


async def _reported_assigned_user(db: AsyncSession, extended: dict | None) -> User | None:
    names = _reported_usernames(extended)
    if not names:
        return None
    rows = (
        await db.execute(select(User).where(func.lower(User.username).in_(names), User.is_active.is_(True)))
    ).scalars().all()
    by_name: dict[str, list[User]] = {}
    for row in rows:
        by_name.setdefault((row.username or "").strip().lower(), []).append(row)
    for name in names:
        candidates = by_name.get(name) or []
        if not candidates:
            continue
        ldap = [u for u in candidates if u.is_ldap]
        if ldap:
            return ldap[0]
        linked_id = next((u.linked_directory_user_id for u in candidates if u.linked_directory_user_id), None)
        if linked_id:
            linked = await db.get(User, linked_id)
            if linked is not None and linked.is_active:
                return linked
        return candidates[0]
    return None


async def verify_agent_token(db: AsyncSession, authorization: str | None, hostname: str) -> None:
    env = (settings.environment or "").strip().lower()
    if env == "development" and settings.allow_dev_any_agent_token:
        if authorization and authorization.startswith("Bearer "):
            return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Нужен заголовок Authorization: Bearer <token>")
    token = authorization.removeprefix("Bearer ").strip()
    legacy_tokens = {t.strip() for t in settings.agent_legacy_tokens.split(",") if t.strip()}
    if _token_matches(token, settings.agent_token) or any(_token_matches(token, item) for item in legacy_tokens):
        return
    if token != settings.agent_token:
        if "." not in token:
            raise HTTPException(status_code=403, detail="Неверный токен агента")
        prefix, secret = token.split(".", 1)
        r = await db.execute(
            select(AgentToken).where(AgentToken.public_id_prefix == prefix, AgentToken.revoked_at.is_(None))
        )
        row = r.scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=403, detail="Неверный токен агента")
        expected = (row.token_hash or "").strip()
        ok = False
        if expected.startswith(_AGENT_TOKEN_PREFIX):
            expected_hex = expected.removeprefix(_AGENT_TOKEN_PREFIX)
            ok = hmac.compare_digest(expected_hex, _hmac_secret(secret))
        else:
            if settings.allow_legacy_agent_token_hashes:
                ok = hmac.compare_digest(expected, secret)
        if not ok:
            raise HTTPException(status_code=403, detail="Неверный токен агента")
        allow = (row.allowed_hostname or "").strip()
        if allow:
            if hostname.strip().lower() != allow.strip().lower():
                raise HTTPException(status_code=403, detail="Токен агента не разрешён для этого хоста")
        row.last_used_at = datetime.now(timezone.utc)


@router.post("/inventory")
@limiter.limit(settings.rate_limit_agent)
async def submit_inventory(
    request: Request,
    report: AgentInventoryReport,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(None),
):
    """Идемпотентно по имени ПК: новый hostname — новая строка; тот же (без учёта регистра) — обновление и замена списка ПО."""
    hn = report.hostname.strip()
    await verify_agent_token(db, authorization, hn)

    hn_key = hn.lower()
    r = await db.execute(
        select(Computer).where(func.lower(Computer.hostname) == hn_key).limit(1)
    )
    pc = r.scalar_one_or_none()
    now = datetime.now(timezone.utc)
    # Persist lean raw: software lives in installed_software; keep count only in blob.
    dump = report.model_dump()
    raw = lean_raw_payload_json(dump)
    reported_user = await _reported_assigned_user(
        db, report.extended if isinstance(report.extended, dict) else None
    )
    mfr = normalize_manufacturer(report.manufacturer)
    model = normalize_system_model(report.model) or normalize_system_model(report.motherboard_product)
    ip_from_agent = primary_ipv4_from_extended(
        report.extended if isinstance(report.extended, dict) else None,
        prefer_mac=report.mac_primary,
    )
    if not ip_from_agent:
        ip_from_agent = resolve_computer_ipv4(
            hostname=hn,
            mac_primary=report.mac_primary,
            raw_payload=None,
        )

    if pc:
        _guard_agent_identity(pc, report)
        action = "updated"
        pc.serial_number = report.serial_number or pc.serial_number
        pc.mac_primary = report.mac_primary or pc.mac_primary
        if ip_from_agent:
            pc.ip_address = ip_from_agent
        pc.cpu = report.cpu
        pc.ram_gb = report.ram_gb
        pc.os_name = report.os_name
        pc.os_version = report.os_version
        pc.manufacturer = mfr
        pc.model = model
        pc.location = report.location
        pc.gpu_name = report.gpu_name
        pc.memory_used_percent = report.memory_used_percent
        pc.motherboard_manufacturer = normalize_manufacturer(report.motherboard_manufacturer)
        pc.motherboard_product = normalize_system_model(report.motherboard_product)
        pc.disks_json = (
            json.dumps([d.model_dump() for d in report.disks], ensure_ascii=False)
            if report.disks
            else pc.disks_json
        )
        pc.last_report_at = now
        pc.raw_payload = raw
        if reported_user is not None:
            pc.assigned_user_id = reported_user.id
        await db.execute(delete(InstalledSoftware).where(InstalledSoftware.computer_id == pc.id))
        await db.execute(delete(Peripheral).where(Peripheral.computer_id == pc.id))
        if report.disks:
            await db.execute(delete(DiskVolume).where(DiskVolume.computer_id == pc.id))
    else:
        action = "created"
        pc = Computer(
            hostname=hn,
            serial_number=report.serial_number,
            mac_primary=report.mac_primary,
            ip_address=ip_from_agent,
            cpu=report.cpu,
            ram_gb=report.ram_gb,
            os_name=report.os_name,
            os_version=report.os_version,
            manufacturer=mfr,
            model=model,
            location=report.location,
            gpu_name=report.gpu_name,
            memory_used_percent=report.memory_used_percent,
            motherboard_manufacturer=normalize_manufacturer(report.motherboard_manufacturer),
            motherboard_product=normalize_system_model(report.motherboard_product),
            disks_json=json.dumps([d.model_dump() for d in report.disks], ensure_ascii=False),
            last_report_at=now,
            raw_payload=raw,
            assigned_user_id=(reported_user.id if reported_user is not None else None),
        )
        db.add(pc)
        await db.flush()

    # Cap normalized software rows to keep list/detail snappy (full list is rare).
    _SOFTWARE_SAVE_MAX = 2500
    saved_sw = 0
    for s in report.software:
        if saved_sw >= _SOFTWARE_SAVE_MAX:
            break
        if not (s.name or "").strip():
            continue
        db.add(
            InstalledSoftware(
                computer_id=pc.id,
                name=s.name[:512],
                version=s.version[:255] if s.version else None,
            )
        )
        saved_sw += 1

    for p in report.peripherals:
        k = (p.kind or "other").strip()[:32] or "other"
        n = (p.name or "").strip()[:512]
        if not n or is_noise_peripheral(k, n):
            continue
        db.add(Peripheral(computer_id=pc.id, kind=k, name=n))

    # Вкладка «Принтеры» — только SNMP (сеть) и ручное добавление; очереди Windows остаются в отчёте агента.

    if report.disks:
        for d in report.disks:
            if not (d.mount or "").strip():
                continue
            db.add(
                DiskVolume(
                    computer_id=pc.id,
                    mount=d.mount[:32],
                    label=(d.label[:255] if d.label else None),
                    total_gb=d.total_gb,
                    used_percent=d.used_percent,
                    free_gb=d.free_gb,
                )
            )

    await db.flush()
    await sync_computer(db, pc)
    await ack_hostname(db, hn)
    await db.commit()
    try:
        _save_inbox_json(hn, pc.id, raw, now)
    except OSError:
        pass

    return {"ok": True, "computer_id": pc.id, "hostname": hn, "action": action}


@router.get("/directive")
@limiter.limit(settings.rate_limit_agent)
async def agent_directive(
    request: Request,
    hostname: str = Query(default="", max_length=255),
    seen_generation: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(None),
):
    """Agent poll: collect now, or because the server schedule advanced the generation."""
    _ = request
    hn = (hostname or "").strip()
    await verify_agent_token(db, authorization, hn or "directive")
    directive = await build_directive(db, hn, seen_generation)
    return {
        "collect": directive.collect,
        "reason": directive.reason,
        "generation": directive.generation,
        "mode": directive.mode,
        "time": directive.time_hhmm,
        "weekday": directive.weekday,
        "timezone": directive.timezone,
        "poll_minutes": directive.poll_minutes,
    }
