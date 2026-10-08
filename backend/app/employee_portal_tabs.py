"""Admin-managed reference tabs shown on /h and the employee desktop client."""

from __future__ import annotations

import json
import re
import secrets
from typing import Any

from fastapi import HTTPException

MAX_TABS = 16
MAX_TITLE = 80
MAX_BODY = 20_000
MAX_COLUMNS = 8
MAX_ROWS = 80
MAX_CELL = 240

__all__ = [
    "normalize_employee_tabs",
    "parse_employee_tabs_json",
    "public_employee_tabs",
    "tabs_to_json",
]


def _clean_id(raw: Any) -> str:
    s = str(raw or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{6,40}", s):
        return s
    return secrets.token_hex(8)


def _clean_cell(raw: Any) -> str:
    return str(raw or "").replace("\x00", "").strip()[:MAX_CELL]


def normalize_employee_tabs(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Вкладки: некорректный JSON") from exc
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="Вкладки должны быть списком")
    if len(raw) > MAX_TABS:
        raise HTTPException(status_code=400, detail=f"Не больше {MAX_TABS} вкладок")

    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail=f"Вкладка #{i + 1}: ожидался объект")
        tab_id = _clean_id(item.get("id"))
        while tab_id in seen:
            tab_id = secrets.token_hex(8)
        seen.add(tab_id)
        title = str(item.get("title") or "").replace("\x00", "").strip()[:MAX_TITLE]
        if not title:
            raise HTTPException(status_code=400, detail=f"Вкладка #{i + 1}: нужен заголовок")
        kind = str(item.get("kind") or "text").strip().lower()
        if kind not in {"text", "table"}:
            raise HTTPException(status_code=400, detail=f"Вкладка «{title}»: kind — text или table")
        body = str(item.get("body") or "").replace("\x00", "")[:MAX_BODY]
        columns_raw = item.get("columns") if isinstance(item.get("columns"), list) else []
        columns = [_clean_cell(c) or f"Колонка {n + 1}" for n, c in enumerate(columns_raw[:MAX_COLUMNS])]
        rows_raw = item.get("rows") if isinstance(item.get("rows"), list) else []
        rows: list[list[str]] = []
        width = max(len(columns), 1)
        for row in rows_raw[:MAX_ROWS]:
            cells = row if isinstance(row, list) else [row]
            padded = [_clean_cell(c) for c in cells[:width]]
            while len(padded) < width:
                padded.append("")
            rows.append(padded)
        if kind == "table" and not columns:
            columns = ["Значение"]
            rows = [[c[0] if c else ""] for c in rows] if rows else []
        out.append(
            {
                "id": tab_id,
                "title": title,
                "kind": kind,
                "body": body,
                "columns": columns,
                "rows": rows,
                "enabled": bool(item.get("enabled", True)),
            }
        )
    return out


def parse_employee_tabs_json(raw: str | None) -> list[dict[str, Any]]:
    try:
        return normalize_employee_tabs(raw or "[]")
    except HTTPException:
        return []


def public_employee_tabs(raw: str | None) -> list[dict[str, Any]]:
    return [tab for tab in parse_employee_tabs_json(raw) if tab.get("enabled")]


def tabs_to_json(tabs: list[dict[str, Any]]) -> str:
    return json.dumps(tabs, ensure_ascii=False)
