"""Синхронизация SERIAL-последовательностей PostgreSQL после миграции SQLite."""
from __future__ import annotations

import asyncio
import os
import sys
from urllib.parse import unquote, urlparse

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BACKEND = os.path.join(_ROOT, "backend")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from app.config import settings  # noqa: E402


def _pg_conn_kwargs() -> dict:
    url = settings.database_url.replace("postgresql+asyncpg", "postgresql")
    p = urlparse(url)
    return {
        "host": p.hostname or "localhost",
        "port": p.port or 5432,
        "user": unquote(p.username or "inventory"),
        "password": unquote(p.password or "inventory"),
        "database": (p.path or "/inventory").lstrip("/") or "inventory",
    }


async def _fix() -> None:
    import asyncpg

    conn = await asyncpg.connect(**_pg_conn_kwargs())
    try:
        seq_rows = await conn.fetch(
            "SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'"
        )
        fixed = 0
        for r in seq_rows:
            seq_name = r["sequencename"]
            if not seq_name.endswith("_id_seq"):
                continue
            table_name = seq_name[: -len("_id_seq")]
            exists = await conn.fetchval(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = $1 LIMIT 1",
                table_name,
            )
            if not exists:
                continue
            max_id = await conn.fetchval(f'SELECT COALESCE(MAX(id), 0) FROM "{table_name}"')
            if max_id and int(max_id) > 0:
                await conn.execute("SELECT setval($1, $2, true)", seq_name, int(max_id))
                print(f"[fix-seq] {seq_name} -> {max_id}", flush=True)
                fixed += 1
        print(f"[fix-seq] Готово, синхронизировано: {fixed}", flush=True)
    finally:
        await conn.close()


def main() -> None:
    if not settings.database_url.lower().startswith("postgresql"):
        print("[fix-seq] DATABASE_URL не PostgreSQL — нечего исправлять", flush=True)
        return
    asyncio.run(_fix())


if __name__ == "__main__":
    main()
