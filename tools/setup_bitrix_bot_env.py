#!/usr/bin/env python3
"""
Bootstrap Bitrix24 test bot settings from `бот-инфо.env` into `backend/.env`.

It extracts:
- BITRIX24_WEBHOOK_URL
- BITRIX24_BOT_ID
- BITRIX24_BOT_CLIENT_ID
- BITRIX24_BOT_HANDLER_TOKEN

Usage (repo root):
  python tools/setup_bitrix_bot_env.py
  python tools/setup_bitrix_bot_env.py --src "бот-инфо.env"
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from urllib.parse import urlparse, parse_qs


_ENV_LINE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$")


def _upsert_dotenv_line(path: Path, key: str, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    if path.is_file():
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    out: list[str] = []
    found = False
    for raw in lines:
        m = _ENV_LINE_RE.match(raw.strip())
        if m and m.group(1) == key:
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(raw)
    if not found:
        if out and out[-1].strip() != "":
            out.append("")
        out.append(f"{key}={value}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8", errors="strict")


def _mask(s: str) -> str:
    t = s.strip()
    if len(t) <= 8:
        return "****"
    return t[:4] + "…" + t[-3:]


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    p = argparse.ArgumentParser()
    p.add_argument("--src", default=str(root / "бот-инфо.env"))
    args = p.parse_args()

    src = Path(args.src)
    if not src.is_file():
        raise SystemExit(f"File not found: {src}")

    text = src.read_text(encoding="utf-8", errors="replace")

    # 1) Webhook base: first URL that contains /rest/<id>/<token>/
    webhook = ""
    for m in re.finditer(r"https?://[^\s]+/rest/\d+/[A-Za-z0-9_\-]+/?", text):
        webhook = m.group(0)
        break
    webhook = webhook.strip()
    if webhook and webhook.endswith("/"):
        webhook = webhook.rstrip("/")

    # 2) Handler token: parse from handler URL (token=...)
    handler_token = ""
    for m in re.finditer(r"https?://[^\s]+/handler\?[^\s]+", text):
        u = m.group(0).strip()
        q = parse_qs(urlparse(u).query)
        cand = (q.get("token") or [""])[0].strip()
        if cand:
            handler_token = cand
            break

    # 3) BOT_ID and CLIENT_ID
    bot_id = ""
    m = re.search(r"\bBOT_ID\s*\n\s*(\d+)\b", text, flags=re.I)
    if m:
        bot_id = m.group(1).strip()
    client_id = ""
    m = re.search(r"\bCLIENT_ID\b.*\n\s*([A-Za-z0-9]+)\b", text, flags=re.I)
    if m:
        client_id = m.group(1).strip()

    if not webhook:
        raise SystemExit("Не нашёл BITRIX24 webhook URL (/rest/<id>/<token>/) в файле.")
    if not handler_token:
        raise SystemExit("Не нашёл token=... в handler URL.")
    if not bot_id:
        raise SystemExit("Не нашёл BOT_ID.")
    if not client_id:
        raise SystemExit("Не нашёл CLIENT_ID.")

    env_path = root / "backend" / ".env"
    _upsert_dotenv_line(env_path, "BITRIX24_WEBHOOK_URL", webhook)
    _upsert_dotenv_line(env_path, "BITRIX24_BOT_ID", bot_id)
    _upsert_dotenv_line(env_path, "BITRIX24_BOT_CLIENT_ID", client_id)
    _upsert_dotenv_line(env_path, "BITRIX24_BOT_HANDLER_TOKEN", handler_token)

    print("OK: written to backend/.env")
    print("BITRIX24_WEBHOOK_URL=", webhook)
    print("BITRIX24_BOT_ID=", bot_id)
    print("BITRIX24_BOT_CLIENT_ID=", _mask(client_id))
    print("BITRIX24_BOT_HANDLER_TOKEN=", _mask(handler_token))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

