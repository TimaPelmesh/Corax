"""
Перенос данных из SQLite (inventory.db, diagrams.db, warehouse.db) в PostgreSQL.

Запуск из корня репозитория:
  python scripts/migrate_sqlite_to_postgres.py
"""
from __future__ import annotations

import asyncio
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

_ROOT = Path(__file__).resolve().parent.parent
_BACKEND = _ROOT / "backend"
_ENV = _BACKEND / ".env"

# Порядок вставки с учётом внешних ключей.
_TABLE_ORDER: list[str] = [
    "users",
    "tags",
    "ldap_config",
    "bitrix24_config",
    "printer_poll_config",
    "service_request_categories",
    "computers",
    "monitors",
    "printers",
    "installed_software",
    "peripherals",
    "disk_volumes",
    "computer_tags",
    "service_requests",
    "service_request_assignees",
    "service_request_templates",
    "service_request_template_assignees",
    "agent_tokens",
    "asset_change_logs",
    "diagrams",
    "diagram_bindings",
    "wiki_rag_documents",
    "warehouse_rooms",
    "stock_items",
    "stock_movements",
]

_BOOL_COLUMNS = {
    "users": {"is_active", "is_superuser", "is_ldap"},
    "computers": set(),
    "printers": {"is_network", "is_shared", "is_default"},
    "ldap_config": {"enabled", "allow_anonymous"},
    "bitrix24_config": {"enabled"},
    "printer_poll_config": {"poll_enabled", "snmp_enabled"},
}


def _read_env(name: str) -> str | None:
    if name in __import__("os").environ and __import__("os").environ[name].strip():
        return __import__("os").environ[name].strip()
    if not _ENV.is_file():
        return None
    for raw in _ENV.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == name:
            return v.strip()
    return None


def _pg_url() -> str:
    return _read_env("DATABASE_URL") or "postgresql+asyncpg://inventory:inventory@localhost:5432/inventory"


def _parse_pg(url: str) -> dict[str, object]:
    u = url.replace("postgresql+asyncpg", "postgresql")
    p = urlparse(u)
    return {
        "host": p.hostname or "localhost",
        "port": p.port or 5432,
        "user": unquote(p.username or "inventory"),
        "password": unquote(p.password or "inventory"),
        "database": (p.path or "/inventory").lstrip("/") or "inventory",
    }


def _sqlite_tables(con: sqlite3.Connection) -> set[str]:
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {r[0] for r in rows}


def _sqlite_columns(con: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in con.execute(f'PRAGMA table_info("{table}")').fetchall()]


def _pg_columns(conn, table: str) -> set[str]:
    rows = asyncio.get_event_loop().run_until_complete(
        conn.fetch(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
            """,
            table,
        )
    )
    return {r["column_name"] for r in rows}


def _parse_datetime(val: str) -> datetime:
    raw = val.strip().replace("Z", "+00:00")
    if "+" in raw[10:]:
        base, tz = raw.rsplit("+", 1)
        dt = datetime.fromisoformat(base.strip())
        return dt.replace(tzinfo=timezone.utc)
    if raw.endswith("+00:00") or "T" in raw:
        try:
            dt = datetime.fromisoformat(raw)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return datetime.fromisoformat(raw)


def _convert_row(table: str, cols: list[str], row: tuple, col_types: dict[str, str]) -> list[object]:
    bools = _BOOL_COLUMNS.get(table, set())
    out: list[object] = []
    for col, val in zip(cols, row, strict=True):
        if val is None:
            out.append(None)
        elif col in bools:
            out.append(bool(val))
        elif col_types.get(col) in {"timestamp with time zone", "timestamp without time zone", "date"}:
            if isinstance(val, str) and val.strip():
                dt = _parse_datetime(val)
                if col_types.get(col) == "timestamp without time zone":
                    out.append(dt.replace(tzinfo=None))
                elif col_types.get(col) == "date":
                    out.append(dt.date())
                else:
                    out.append(dt)
            else:
                out.append(val)
        elif isinstance(val, bytes):
            out.append(val.replace(b"\x00", b""))
        elif isinstance(val, str):
            out.append(val.replace("\x00", ""))
        else:
            out.append(val)
    return out


def _collect_sources() -> dict[str, Path]:
    mapping = {
        "inventory": _BACKEND / "inventory.db",
        "diagrams": _BACKEND / "diagrams.db",
        "warehouse": _BACKEND / "warehouse.db",
    }
    return {k: v for k, v in mapping.items() if v.is_file()}


async def _migrate() -> None:
    import asyncpg

    sources = _collect_sources()
    if not sources:
        print("[migrate] SQLite .db файлы не найдены в backend/", flush=True)
        return

    inv = sources.get("inventory")
    if inv and sqlite3.connect(inv).execute("SELECT COUNT(*) FROM computers").fetchone()[0] == 0:
        print("[migrate] inventory.db пуст — нечего переносить", flush=True)
        return

    pg = _parse_pg(_pg_url())
    admin_password = _read_env("POSTGRES_ADMIN_PASSWORD") or pg["password"]
    admin_user = _read_env("POSTGRES_ADMIN_USER") or "postgres"

    try:
        conn = await asyncpg.connect(
            host=pg["host"],
            port=pg["port"],
            user=admin_user,
            password=admin_password,
            database=pg["database"],
        )
    except Exception:
        conn = await asyncpg.connect(**pg)

    try:
        existing = await conn.fetchval("SELECT COUNT(*) FROM computers")
        if existing and int(existing) > 0:
            if "--force" not in sys.argv:
                print(
                    f"[migrate] В PostgreSQL уже есть {existing} компьютеров — пропуск. "
                    "Для полного переноса: --force, для дозагрузки схем/склада: --append",
                    flush=True,
                )
                return
            print(f"[migrate] --force: перезапись (было {existing} компьютеров)", flush=True)

        print("[migrate] Очистка PostgreSQL …", flush=True)
        tables = await conn.fetch(
            """
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename != 'schema_migrations'
            """
        )
        names = [r["tablename"] for r in tables]
        if names:
            await conn.execute(f"TRUNCATE {', '.join(names)} RESTART IDENTITY CASCADE")

        try:
            await conn.execute("SET session_replication_role = replica")
            use_replica = True
        except Exception:
            use_replica = False

        total_rows = 0
        # inventory.db — основной массив данных
        if inv:
            total_rows += await _import_sqlite(conn, inv, "inventory.db")

        # diagrams.db — актуальные схемы (перезаписывают по id)
        diag = sources.get("diagrams")
        if diag:
            total_rows += await _import_sqlite(
                conn, diag, "diagrams.db", tables={"diagrams", "diagram_bindings"}, upsert=True
            )

        # warehouse.db
        wh = sources.get("warehouse")
        if wh:
            total_rows += await _import_sqlite(
                conn,
                wh,
                "warehouse.db",
                tables={"warehouse_rooms", "stock_items", "stock_movements"},
                upsert=True,
            )

        if use_replica:
            await conn.execute("SET session_replication_role = DEFAULT")
        await _fix_sequences(conn)

        users = await conn.fetchval("SELECT COUNT(*) FROM users")
        computers = await conn.fetchval("SELECT COUNT(*) FROM computers")
        software = await conn.fetchval("SELECT COUNT(*) FROM installed_software")
        diagrams = await conn.fetchval("SELECT COUNT(*) FROM diagrams")
        requests = await conn.fetchval("SELECT COUNT(*) FROM service_requests")

        print("[migrate] Готово.", flush=True)
        print(
            f"[migrate] users={users}, computers={computers}, software={software}, "
            f"diagrams={diagrams}, service_requests={requests}, rows_copied≈{total_rows}",
            flush=True,
        )
    finally:
        await conn.close()


async def _import_sqlite(
    conn,
    db_path: Path,
    label: str,
    *,
    tables: set[str] | None = None,
    upsert: bool = False,
) -> int:
    sqlite_con = sqlite3.connect(db_path)
    sqlite_con.row_factory = sqlite3.Row
    available = _sqlite_tables(sqlite_con)
    order = [t for t in _TABLE_ORDER if t in available and (tables is None or t in tables)]
    extra = [t for t in sorted(available) if t not in order and t != "schema_migrations" and (tables is None or t in tables)]
    order.extend(extra)

    copied = 0
    pg_cols_cache: dict[str, set[str]] = {}
    pg_types_cache: dict[str, dict[str, str]] = {}

    for table in order:
        if table not in available:
            continue
        sqlite_cols = _sqlite_columns(sqlite_con, table)
        if table not in pg_cols_cache:
            rows_meta = await conn.fetch(
                """
                SELECT column_name, data_type FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                """,
                table,
            )
            pg_cols_cache[table] = {r["column_name"] for r in rows_meta}
            pg_types_cache[table] = {r["column_name"]: r["data_type"] for r in rows_meta}
        pg_cols = pg_cols_cache[table]
        col_types = pg_types_cache[table]
        cols = [c for c in sqlite_cols if c in pg_cols]
        if not cols:
            continue

        rows = []
        try:
            rows = sqlite_con.execute(f'SELECT {", ".join(cols)} FROM "{table}"').fetchall()
        except sqlite3.DatabaseError as exc:
            print(f"[migrate] {label} -> {table}: SKIP (sqlite error: {exc})", flush=True)
            continue
        if table == "service_request_categories":
            rows = sorted(rows, key=lambda r: (r["parent_id"] is not None, r["parent_id"] or 0, r["id"]))
        if not rows:
            continue

        col_list = ", ".join(cols)
        placeholders = ", ".join(f"${i + 1}" for i in range(len(cols)))
        if upsert and "id" in cols:
            updates = ", ".join(f"{c}=EXCLUDED.{c}" for c in cols if c != "id")
            sql = (
                f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) "
                f"ON CONFLICT (id) DO UPDATE SET {updates}"
            )
        else:
            sql = f"INSERT INTO {table} ({col_list}) VALUES ({placeholders})"

        batch: list[tuple] = []
        for row in rows:
            batch.append(tuple(_convert_row(table, cols, tuple(row[c] for c in cols), col_types)))

        for chunk_start in range(0, len(batch), 500):
            chunk = batch[chunk_start : chunk_start + 500]
            async with conn.transaction():
                for values in chunk:
                    await conn.execute(sql, *values)
            copied += len(chunk)

        print(f"[migrate] {label} -> {table}: {len(rows)}", flush=True)

    sqlite_con.close()
    return copied


async def _fix_sequences(conn) -> None:
    tables = await conn.fetch(
        """
        SELECT c.relname AS table_name, a.attname AS column_name
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid
        JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
        JOIN pg_class seq ON seq.oid = d.refobjid AND seq.relkind = 'S'
        WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        """
    )
    for r in tables:
        table, column = r["table_name"], r["column_name"]
        seq = await conn.fetchval("SELECT pg_get_serial_sequence($1, $2)", table, column)
        if not seq:
            continue
        max_id = await conn.fetchval(f'SELECT COALESCE(MAX("{column}"), 0) FROM "{table}"')
        if max_id:
            await conn.execute("SELECT setval($1, $2, true)", seq, int(max_id))


def main() -> None:
    if "--append" in sys.argv:
        asyncio.run(_migrate_append())
        return
    asyncio.run(_migrate())


async def _migrate_append() -> None:
    """Дозагрузка без TRUNCATE (diagrams.db, warehouse.db)."""
    import asyncpg

    sources = _collect_sources()
    pg = _parse_pg(_pg_url())
    admin_password = _read_env("POSTGRES_ADMIN_PASSWORD") or pg["password"]
    admin_user = _read_env("POSTGRES_ADMIN_USER") or "postgres"
    try:
        conn = await asyncpg.connect(
            host=pg["host"], port=pg["port"], user=admin_user,
            password=admin_password, database=pg["database"],
        )
    except Exception:
        conn = await asyncpg.connect(**pg)
    try:
        total = 0
        if sources.get("diagrams"):
            total += await _import_sqlite(
                conn, sources["diagrams"], "diagrams.db",
                tables={"diagrams", "diagram_bindings"}, upsert=True,
            )
        if sources.get("warehouse"):
            total += await _import_sqlite(
                conn, sources["warehouse"], "warehouse.db",
                tables={"warehouse_rooms", "stock_items", "stock_movements"}, upsert=True,
            )
        diagrams = await conn.fetchval("SELECT COUNT(*) FROM diagrams")
        print(f"[migrate] append done, diagrams={diagrams}, rows~={total}", flush=True)
    finally:
        await conn.close()


if __name__ == "__main__":
    main()
