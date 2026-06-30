"""PostgreSQL dump/restore via pg_dump/pg_restore (admin backup in settings)."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

from app.config import settings

_MAX_RESTORE_BYTES = 512 * 1024 * 1024


@dataclass(frozen=True)
class PgConn:
    host: str
    port: int
    user: str
    password: str
    dbname: str


def parse_database_url(url: str) -> PgConn:
    normalized = url.strip().replace("postgresql+asyncpg://", "postgresql://", 1)
    parsed = urlparse(normalized)
    return PgConn(
        host=parsed.hostname or "localhost",
        port=int(parsed.port or 5432),
        user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""),
        dbname=(parsed.path or "/").lstrip("/") or "postgres",
    )


def _pg_bin_dir() -> Path | None:
    raw = (
        (settings.pg_bin_dir or "").strip()
        or (os.environ.get("PG_BIN_DIR") or "").strip()
        or (os.environ.get("PGBIN") or "").strip()
    ).strip('"')
    if not raw:
        return None
    p = Path(raw)
    if p.is_dir():
        return p
    return None


def configured_pg_bin_dir() -> str | None:
    """Путь из .env (для диагностики в UI), даже если pg_dump не найден."""
    raw = (settings.pg_bin_dir or "").strip() or (os.environ.get("PG_BIN_DIR") or "").strip()
    return raw or None


def find_pg_executable(tool: str) -> Path:
    """Resolve pg_dump / pg_restore / psql."""
    name = f"{tool}.exe" if os.name == "nt" else tool
    bindir = _pg_bin_dir()
    if bindir is not None:
        cand = bindir / name
        if cand.is_file():
            return cand
        raise FileNotFoundError(
            f"{tool} не найден в PG_BIN_DIR={bindir}. Проверьте, что в папке есть {name}."
        )
    which = shutil.which(tool)
    if which:
        return Path(which)
    if os.name == "nt":
        for ver in range(20, 13, -1):
            cand = Path(f"C:/Program Files/PostgreSQL/{ver}/bin/{name}")
            if cand.is_file():
                return cand
    raise FileNotFoundError(
        f"{tool} не найден. Установите PostgreSQL client tools или задайте PG_BIN_DIR в backend/.env "
        f"(например C:\\Program Files\\PostgreSQL\\18\\bin)."
    )


def pg_tools_status() -> dict:
    out: dict[str, object] = {
        "pg_dump_available": False,
        "pg_restore_available": False,
        "pg_dump_path": None,
        "pg_restore_path": None,
    }
    for tool, key in (("pg_dump", "pg_dump"), ("pg_restore", "pg_restore")):
        try:
            path = find_pg_executable(tool)
            out[f"{key}_available"] = True
            out[f"{key}_path"] = str(path)
        except FileNotFoundError:
            pass
    return out


def _subprocess_env(password: str) -> dict[str, str]:
    env = os.environ.copy()
    if password:
        env["PGPASSWORD"] = password
    return env


def create_database_dump() -> tuple[bytes, str]:
    if not settings.database_url.strip().lower().startswith("postgresql"):
        raise ValueError("Резервная копия поддерживается только для PostgreSQL (DATABASE_URL).")

    cfg = parse_database_url(settings.database_url)
    if not cfg.user or not cfg.dbname:
        raise ValueError("Некорректный DATABASE_URL: нужны пользователь и имя базы.")

    exe = find_pg_executable("pg_dump")
    fd, out_path = tempfile.mkstemp(suffix=".dump", prefix="corax-export-")
    os.close(fd)
    try:
        cmd = [
            str(exe),
            "-h",
            cfg.host,
            "-p",
            str(cfg.port),
            "-U",
            cfg.user,
            "-d",
            cfg.dbname,
            "-F",
            "c",
            "-f",
            out_path,
            "--no-owner",
            "--no-acl",
        ]
        result = subprocess.run(
            cmd,
            env=_subprocess_env(cfg.password),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
            check=False,
        )
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip()[-1200:]
            raise RuntimeError(f"pg_dump завершился с кодом {result.returncode}: {tail}")

        data = Path(out_path).read_bytes()
        if not data:
            raise RuntimeError("pg_dump создал пустой файл.")
    finally:
        Path(out_path).unlink(missing_ok=True)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"corax-{cfg.dbname}-{stamp}.dump"
    return data, filename


async def _terminate_other_sessions(cfg: PgConn) -> None:
    import asyncpg

    admin_user = (settings.postgres_admin_user or "").strip() or "postgres"
    admin_password = (settings.postgres_admin_password or "").strip()

    conn = None
    if admin_password:
        try:
            conn = await asyncpg.connect(
                host=cfg.host,
                port=cfg.port,
                user=admin_user,
                password=admin_password,
                database="postgres",
                timeout=12,
            )
        except Exception:
            conn = None

    if conn is None:
        conn = await asyncpg.connect(
            host=cfg.host,
            port=cfg.port,
            user=cfg.user,
            password=cfg.password,
            database=cfg.dbname,
            timeout=12,
        )

    try:
        await conn.execute(
            """
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()
            """,
            cfg.dbname,
        )
    finally:
        await conn.close()


async def restore_database_dump(file_bytes: bytes) -> dict:
    if len(file_bytes) > _MAX_RESTORE_BYTES:
        raise ValueError(f"Файл слишком большой (макс. {_MAX_RESTORE_BYTES // (1024 * 1024)} МБ).")
    if len(file_bytes) < 64:
        raise ValueError("Файл слишком маленький для дампа PostgreSQL.")

    if not settings.database_url.strip().lower().startswith("postgresql"):
        raise ValueError("Восстановление поддерживается только для PostgreSQL.")

    cfg = parse_database_url(settings.database_url)
    exe = find_pg_executable("pg_restore")

    from app.database import diagrams_engine, engine, warehouse_engine

    await engine.dispose()
    await diagrams_engine.dispose()
    await warehouse_engine.dispose()

    await _terminate_other_sessions(cfg)

    fd, in_path = tempfile.mkstemp(suffix=".dump", prefix="corax-import-")
    os.close(fd)
    try:
        Path(in_path).write_bytes(file_bytes)
        cmd = [
            str(exe),
            "-h",
            cfg.host,
            "-p",
            str(cfg.port),
            "-U",
            cfg.user,
            "-d",
            cfg.dbname,
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-acl",
            in_path,
        ]
        result = subprocess.run(
            cmd,
            env=_subprocess_env(cfg.password),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=900,
            check=False,
        )
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        combined = "\n".join(x for x in (stderr, stdout) if x)
        # pg_restore often returns 1 for benign warnings
        fatal = result.returncode not in (0, 1)
        if fatal and not combined:
            raise RuntimeError(f"pg_restore завершился с кодом {result.returncode}.")
        if fatal:
            raise RuntimeError(combined[-2000:])

        from app.migrations import apply_migrations

        async with engine.begin() as conn:
            await conn.run_sync(apply_migrations)

        warnings = bool(combined) and result.returncode == 1
        return {
            "ok": True,
            "database": cfg.dbname,
            "bytes": len(file_bytes),
            "warnings": warnings,
            "log_tail": combined[-1500:] if combined else "",
            "restart_recommended": True,
        }
    finally:
        Path(in_path).unlink(missing_ok=True)
