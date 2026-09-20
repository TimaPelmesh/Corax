"""Cached read-only Zabbix data for panel (dashboard, PC card, knowledge base)."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ZabbixConfig
from app.zabbix_client import (
    ZabbixClientError,
    fetch_host_rows,
    fetch_overview,
    fetch_problem_rows,
    find_host_by_hostname,
    open_zabbix_session,
    ui_base_url,
)

_CACHE_TTL_SEC = 45.0
_cache: dict[str, tuple[float, Any]] = {}
_locks: dict[str, asyncio.Lock] = {}


def invalidate_zabbix_cache() -> None:
    _cache.clear()


def _cache_get(key: str) -> Any | None:
    row = _cache.get(key)
    if not row:
        return None
    expires, value = row
    if time.monotonic() >= expires:
        _cache.pop(key, None)
        return None
    return value


def _cache_put(key: str, value: Any) -> Any:
    _cache[key] = (time.monotonic() + _CACHE_TTL_SEC, value)
    return value


def _lock_for(key: str) -> asyncio.Lock:
    lock = _locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _locks[key] = lock
    return lock


async def load_zabbix_config(db: AsyncSession) -> ZabbixConfig | None:
    return await db.get(ZabbixConfig, 1)


def config_ready(row: ZabbixConfig | None) -> tuple[bool, str]:
    if row is None or not bool(row.enabled):
        return False, "Интеграция Zabbix выключена"
    if not (row.base_url or "").strip():
        return False, "Не задан URL Zabbix"
    if not (row.api_token or "").strip():
        return False, "Не задан API token Zabbix"
    return True, ""


async def _with_session(row: ZabbixConfig, fn):
    session = await asyncio.to_thread(
        open_zabbix_session,
        base_url=row.base_url or "",
        api_token=row.api_token or "",
        verify_tls=bool(row.verify_tls),
    )
    return await asyncio.to_thread(fn, session)


async def get_overview_payload(db: AsyncSession) -> dict[str, Any]:
    row = await load_zabbix_config(db)
    ok, msg = config_ready(row)
    base = {
        "enabled": bool(row.enabled) if row else False,
        "available": False,
        "message": msg,
        "ui_url": ui_base_url(row.base_url) if row and row.base_url else "",
        "version": (row.last_version if row else "") or None,
        "hosts_total": row.last_hosts_total if row else None,
        "problems_total": row.last_problems_total if row else None,
        "problems": [],
        "severity_sample": {},
        "cached": False,
    }
    if not ok or row is None:
        return base

    cache_key = "overview"
    cached = _cache_get(cache_key)
    if cached is not None:
        out = dict(cached)
        out["cached"] = True
        return out

    async with _lock_for(cache_key):
        cached = _cache_get(cache_key)
        if cached is not None:
            out = dict(cached)
            out["cached"] = True
            return out
        try:
            data = await _with_session(row, lambda s: fetch_overview(s, problem_limit=15))
        except ZabbixClientError as exc:
            base["message"] = str(exc)
            return base
        except Exception as exc:  # noqa: BLE001 — surface to UI
            base["message"] = f"Ошибка Zabbix: {exc}"
            return base

        payload = {
            "enabled": True,
            "available": True,
            "message": "OK",
            "ui_url": ui_base_url(row.base_url or ""),
            "version": data.get("version") or row.last_version or None,
            "hosts_total": data.get("hosts_total"),
            "problems_total": data.get("problems_total"),
            "problems": data.get("problems") or [],
            "severity_sample": data.get("severity_sample") or {},
            "cached": False,
        }
        return _cache_put(cache_key, payload)


async def get_problems_payload(db: AsyncSession, *, limit: int = 50) -> dict[str, Any]:
    row = await load_zabbix_config(db)
    ok, msg = config_ready(row)
    if not ok or row is None:
        return {"enabled": False, "available": False, "message": msg, "items": [], "total": None}

    lim = max(1, min(int(limit), 200))
    cache_key = f"problems:{lim}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    async with _lock_for(cache_key):
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
        try:

            def _load(session):
                items = fetch_problem_rows(session, limit=lim)
                total = session.call("problem.get", {"countOutput": True, "recent": False})
                try:
                    total_n = int(total)
                except (TypeError, ValueError):
                    total_n = None
                return items, total_n

            items, total_n = await _with_session(row, _load)
        except ZabbixClientError as exc:
            return {"enabled": True, "available": False, "message": str(exc), "items": [], "total": None}
        payload = {
            "enabled": True,
            "available": True,
            "message": "OK",
            "items": items,
            "total": total_n,
            "cached": False,
        }
        return _cache_put(cache_key, payload)


async def get_hosts_payload(db: AsyncSession, *, limit: int = 100) -> dict[str, Any]:
    row = await load_zabbix_config(db)
    ok, msg = config_ready(row)
    if not ok or row is None:
        return {"enabled": False, "available": False, "message": msg, "items": [], "total": None}

    lim = max(1, min(int(limit), 500))
    cache_key = f"hosts:{lim}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    async with _lock_for(cache_key):
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}
        try:

            def _load(session):
                items = fetch_host_rows(session, limit=lim)
                total = session.call("host.get", {"countOutput": True})
                try:
                    total_n = int(total)
                except (TypeError, ValueError):
                    total_n = None
                return items, total_n

            items, total_n = await _with_session(row, _load)
        except ZabbixClientError as exc:
            return {"enabled": True, "available": False, "message": str(exc), "items": [], "total": None}
        payload = {
            "enabled": True,
            "available": True,
            "message": "OK",
            "items": items,
            "total": total_n,
            "cached": False,
        }
        return _cache_put(cache_key, payload)


async def get_host_status_payload(db: AsyncSession, hostname: str) -> dict[str, Any]:
    row = await load_zabbix_config(db)
    ok, msg = config_ready(row)
    base = {
        "enabled": bool(row.enabled) if row else False,
        "available": False,
        "matched": False,
        "message": msg,
        "ui_url": ui_base_url(row.base_url) if row and row.base_url else "",
        "host": None,
        "problems_total": 0,
        "problems": [],
    }
    if not ok or row is None:
        return base

    host_key = (hostname or "").strip().lower()
    if not host_key:
        base["message"] = "Пустой hostname"
        return base

    cache_key = f"host:{host_key}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    async with _lock_for(cache_key):
        cached = _cache_get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

        def _load(session):
            host = find_host_by_hostname(session, hostname)
            if not host:
                return None, [], 0
            problems = fetch_problem_rows(session, limit=8, hostids=[host["hostid"]])
            total_raw = session.call(
                "problem.get",
                {"countOutput": True, "recent": False, "hostids": [host["hostid"]]},
            )
            try:
                total_n = int(total_raw)
            except (TypeError, ValueError):
                total_n = len(problems)
            return host, problems, total_n

        try:
            host, problems, problems_total = await _with_session(row, _load)
        except ZabbixClientError as exc:
            base["message"] = str(exc)
            return base

        if not host:
            payload = {
                "enabled": True,
                "available": True,
                "matched": False,
                "message": "Хост не найден в Zabbix",
                "ui_url": ui_base_url(row.base_url or ""),
                "host": None,
                "problems_total": 0,
                "problems": [],
                "cached": False,
            }
            return _cache_put(cache_key, payload)

        host_out = {
            **host,
            "disabled": int(host.get("status") or 0) == 1,
        }
        payload = {
            "enabled": True,
            "available": True,
            "matched": True,
            "message": "OK",
            "ui_url": ui_base_url(row.base_url or ""),
            "host": host_out,
            "problems_total": problems_total,
            "problems": problems,
            "cached": False,
        }
        return _cache_put(cache_key, payload)
