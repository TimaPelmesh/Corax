"""Ручной быстрый пинг зоны сети.

Только ICMP и, у ответивших, короткое обратное имя. SNMP, LLDP, тип
устройства и агент остаются тихому опросу.
"""

from __future__ import annotations

import asyncio
import ipaddress
import platform
import re
import subprocess
import time
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import NetworkDevice
from app.network_classify import network_dedupe_key_for_ip
from app.network_poll_config import get_effective_network_poll_config
from app.network_snmp_discover import _inventory_pc_entries, _known_device_ips, resolve_discovery_networks
from app.printer_poll import icmp_echo_ok

ProgressFn = Callable[[int, str], Awaitable[None]]

_WIN32 = platform.system().lower() == "windows"
_CREATE_NO_WINDOW = 0x08000000
# Дольше ждём эхо, чем в первом варианте, и держим больше пингов сразу.
_FAST_PING_WORKERS = 384 if _WIN32 else 448
_PING_MAX_UNITS = 256
_PING_MAX_HOSTS = 65536
_PTR_WORKERS = 32
_PTR_TIMEOUT_SEC = 0.6
_PROGRESS_EVERY = 250
_UPDATE_CHUNK = 500

_PTR_NAME = re.compile(r"(?im)^(?:name|имя)\s*:\s*([A-Za-z0-9._-]{1,253})\s*$")


@dataclass
class PingSweepResult:
    scanned: int = 0
    alive: int = 0
    created: int = 0
    updated: int = 0
    named: int = 0
    duration_ms: int = 0
    networks: list[str] = field(default_factory=list)
    message: str = ""


def _hosts(networks: list[ipaddress.IPv4Network]) -> tuple[list[str], bool]:
    seen: set[str] = set()
    out: list[str] = []
    truncated = False
    for net in networks:
        for host in net.hosts():
            ip = str(host)
            if ip in seen:
                continue
            seen.add(ip)
            out.append(ip)
            if len(out) >= _PING_MAX_HOSTS:
                return out, True
    return out, truncated


def expand_ping_networks(cidrs: list[str], prefix: int) -> list[ipaddress.IPv4Network]:
    """Широкую сеть режем на выбранную маску. Узкая сеть остаётся как написана."""
    prefix = max(16, min(30, int(prefix)))
    units: list[ipaddress.IPv4Network] = []
    seen: set[ipaddress.IPv4Network] = set()
    for raw in cidrs:
        try:
            net = ipaddress.ip_network(str(raw).strip(), strict=False)
        except ValueError:
            continue
        if not isinstance(net, ipaddress.IPv4Network):
            continue
        parts = [net] if net.prefixlen >= prefix else net.subnets(new_prefix=prefix)
        for part in parts:
            if part.prefixlen < 16 or part.prefixlen > 30 or part in seen:
                continue
            seen.add(part)
            units.append(part)
            if len(units) >= _PING_MAX_UNITS:
                return units
    return units


def _run_cmd(cmd: list[str], timeout: float) -> bytes | None:
    try:
        kwargs: dict = {"capture_output": True, "timeout": timeout}
        if _WIN32:
            kwargs["creationflags"] = _CREATE_NO_WINDOW
        proc = subprocess.run(cmd, **kwargs)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return (proc.stdout or b"") + b"\n" + (proc.stderr or b"")


def _ping_once(ip: str, timeout_ms: int = 1000) -> bool:
    wait_ms = max(500, min(int(timeout_ms), 2000))
    if _WIN32:
        cmd = ["ping", "-n", "1", "-4", "-w", str(wait_ms), ip]
        safety = wait_ms / 1000 + 0.45
    else:
        seconds = max(1, int(round(wait_ms / 1000)))
        cmd = ["ping", "-c", "1", "-W", str(seconds), ip]
        safety = seconds + 0.45
    blob = _run_cmd(cmd, safety)
    return icmp_echo_ok(blob)


def _ptr_name(ip: str) -> str | None:
    if _WIN32:
        blob = _run_cmd(["nslookup", ip], _PTR_TIMEOUT_SEC)
        if not blob:
            return None
        for enc in ("cp866", "cp1251", "utf-8"):
            match = _PTR_NAME.search(blob.decode(enc, errors="ignore"))
            if not match:
                continue
            name = match.group(1).strip().rstrip(".")
            if name and name != ip:
                return name[:255]
        return None
    blob = _run_cmd(["getent", "hosts", ip], _PTR_TIMEOUT_SEC)
    if not blob:
        return None
    for line in blob.decode("utf-8", errors="ignore").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == ip:
            name = parts[1].strip().rstrip(".")
            if name and name != ip:
                return name[:255]
    return None


def _placeholder(hostname: str | None, ip: str) -> bool:
    name = (hostname or "").strip()
    return not name or name == ip or name == f"Host · {ip}"


async def _map_alive(
    ips: list[str],
    worker,
    workers: int,
    on_done: Callable[[int, int, int], Awaitable[None]],
    *,
    gap_sec: float,
) -> list[str]:
    if not ips:
        return []
    loop = asyncio.get_running_loop()
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="net-ping")
    alive: list[str] = []
    done = 0
    total = len(ips)
    step = _progress_step(total)
    pace = asyncio.Lock()
    next_at = 0.0
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    for ip in ips:
        queue.put_nowait(ip)

    async def runner() -> None:
        nonlocal done, next_at
        while True:
            ip = await queue.get()
            if ip is None:
                queue.task_done()
                return
            if gap_sec > 0:
                async with pace:
                    now = time.monotonic()
                    wait = next_at - now
                    if wait > 0:
                        await asyncio.sleep(wait)
                    next_at = time.monotonic() + gap_sec
            ok = False
            try:
                ok = bool(await loop.run_in_executor(pool, worker, ip))
            except Exception:
                ok = False
            finally:
                queue.task_done()
            done += 1
            if ok:
                alive.append(ip)
            if done == total or done % step == 0:
                try:
                    await on_done(done, total, len(alive))
                except Exception:
                    pass

    tasks = [asyncio.create_task(runner()) for _ in range(min(workers, total))]
    for _ in tasks:
        queue.put_nowait(None)
    try:
        await queue.join()
        await asyncio.gather(*tasks)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return alive


async def _lookup_names(
    ips: list[str],
    on_done: Callable[[int, int], Awaitable[None]],
) -> dict[str, str]:
    if not ips:
        return {}
    loop = asyncio.get_running_loop()
    workers = min(_PTR_WORKERS, len(ips))
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="net-ptr")
    names: dict[str, str] = {}
    done = 0
    total = len(ips)
    step = _progress_step(total)
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    for ip in ips:
        queue.put_nowait(ip)

    async def runner() -> None:
        nonlocal done
        while True:
            ip = await queue.get()
            if ip is None:
                queue.task_done()
                return
            name = None
            try:
                name = await loop.run_in_executor(pool, _ptr_name, ip)
            except Exception:
                name = None
            finally:
                queue.task_done()
            done += 1
            if name:
                names[ip] = name
            if done == total or done % step == 0:
                try:
                    await on_done(done, total)
                except Exception:
                    pass

    tasks = [asyncio.create_task(runner()) for _ in range(workers)]
    for _ in tasks:
        queue.put_nowait(None)
    try:
        await queue.join()
        await asyncio.gather(*tasks)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return names


def _chunks(items: list[int], size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _progress_step(total: int) -> int:
    if total >= 2000:
        return _PROGRESS_EVERY
    return max(1, total // 20)


async def run_fast_ping_sweep(
    db: AsyncSession,
    progress_cb: ProgressFn | None = None,
) -> PingSweepResult:
    started = time.monotonic()
    result = PingSweepResult()

    async def report(progress: int, message: str) -> None:
        if progress_cb is not None:
            await progress_cb(progress, message)

    cfg = await get_effective_network_poll_config(db)
    timeout_ms = cfg.ping_timeout_ms
    gap_sec = cfg.ping_gap_ms / 1000.0
    if cfg.ping_cidr_list:
        networks = expand_ping_networks(cfg.ping_cidr_list, cfg.ping_prefix)
    else:
        inventory = await _inventory_pc_entries(db, networks=None)
        known = await _known_device_ips(db)
        hint_ips = [ip for ip, _hn in inventory] + known
        networks, _reasons = resolve_discovery_networks(None, hint_ips=hint_ips)
    result.networks = [str(net) for net in networks]
    if not networks:
        result.message = "Зона пинга не задана. Укажите сети и маску в настройках или оставьте автозону."
        result.duration_ms = int((time.monotonic() - started) * 1000)
        return result

    existing = (
        await db.execute(
            select(
                NetworkDevice.id,
                NetworkDevice.ip_address,
                NetworkDevice.dedupe_key,
                NetworkDevice.hostname,
            )
        )
    ).all()
    # Пинг длится дольше транзакции. Закрываем её до первого пакета.
    await db.commit()

    by_ip: dict[str, tuple[int, str | None]] = {}
    by_key: dict[str, tuple[int, str | None]] = {}
    for row_id, ip, dedupe, hostname in existing:
        ip_s = str(ip or "").strip()
        packed = (int(row_id), hostname)
        if ip_s:
            by_ip[ip_s] = packed
        if dedupe:
            by_key[str(dedupe)] = packed

    ips, truncated = _hosts(networks)
    total = len(ips)
    cut = ", список обрезан" if truncated else ""
    await report(
        4,
        f"Быстрый пинг: {len(networks)} сетей, {total} адресов, "
        f"ждём ответ {timeout_ms} мс, пауза {cfg.ping_gap_ms:g} мс{cut}…",
    )
    if total == 0:
        result.message = "В зоне нет адресов для пинга."
        result.duration_ms = int((time.monotonic() - started) * 1000)
        return result

    ping_mark = 0

    async def on_ping(done: int, count: int, hits: int) -> None:
        nonlocal ping_mark
        if done < ping_mark:
            return
        ping_mark = done
        elapsed = max(time.monotonic() - started, 0.001)
        speed = int(done / elapsed)
        pct = 5 + int(80 * done / max(count, 1))
        await report(pct, f"Пинг {done}/{count} (~{speed} адр/сек), живых {hits}")

    alive = await _map_alive(
        ips,
        partial(_ping_once, timeout_ms=timeout_ms),
        min(_FAST_PING_WORKERS, total),
        on_ping,
        gap_sec=gap_sec,
    )
    result.scanned = total
    result.alive = len(alive)

    ptr_mark = 0

    async def on_ptr(done: int, count: int) -> None:
        nonlocal ptr_mark
        if done < ptr_mark:
            return
        ptr_mark = done
        pct = 86 + int(8 * done / max(count, 1))
        await report(pct, f"Имена ответивших: {done}/{count}")

    names = await _lookup_names(alive, on_ptr)
    result.named = len(names)

    await report(96, f"Сохраняем {len(alive)} живых адресов…")
    now = datetime.now(timezone.utc)
    touch_ids: list[int] = []
    renames: list[tuple[int, str]] = []
    fresh: list[NetworkDevice] = []
    seen_new: set[str] = set()

    for ip in alive:
        key = network_dedupe_key_for_ip(ip)
        found = by_ip.get(ip) or by_key.get(key)
        ptr = names.get(ip)
        if found is not None:
            row_id, hostname = found
            touch_ids.append(row_id)
            if ptr and _placeholder(hostname, ip):
                renames.append((row_id, ptr))
            continue
        if ip in seen_new:
            continue
        seen_new.add(ip)
        fresh.append(
            NetworkDevice(
                dedupe_key=key,
                ip_address=ip,
                hostname=(ptr or f"Host · {ip}")[:255],
                device_type="unknown",
                snmp_status="unknown",
                source="ping",
                last_seen_at=now,
            )
        )

    for chunk in _chunks(touch_ids, _UPDATE_CHUNK):
        await db.execute(
            update(NetworkDevice).where(NetworkDevice.id.in_(chunk)).values(last_seen_at=now)
        )
    for row_id, hostname in renames:
        await db.execute(
            update(NetworkDevice).where(NetworkDevice.id == row_id).values(hostname=hostname)
        )
    if fresh:
        db.add_all(fresh)
    await db.commit()

    result.created = len(fresh)
    result.updated = len(touch_ids)
    result.duration_ms = int((time.monotonic() - started) * 1000)
    shown = result.networks[:4]
    more = len(result.networks) - len(shown)
    zone = ", ".join(shown) + (f" (+{more})" if more else "")
    result.message = (
        f"Быстрый пинг: {result.alive} живых из {result.scanned}, "
        f"новых {result.created}, обновлено {result.updated}, имён {result.named}. "
        f"Зона: {zone}. Тип, агент и соседи — «Найти и опросить»."
    )
    return result
