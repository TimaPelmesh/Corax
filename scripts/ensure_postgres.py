"""Локальный PostgreSQL (без Docker): запуск службы и инициализация БД inventory."""
from __future__ import annotations

import asyncio
import glob
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

_ROOT = Path(__file__).resolve().parent.parent
_ENV_FILE = _ROOT / "backend" / ".env"
_DEFAULT_URL = "postgresql+asyncpg://inventory:inventory@localhost:5432/inventory"
_PORT_WAIT_SECONDS = 90

_APP_DB = "inventory"
_APP_USER = "inventory"
_APP_PASSWORD = "inventory"

_SUBPROC_KW: dict = {"capture_output": True, "check": False}
if sys.version_info >= (3, 7):
    _SUBPROC_KW["encoding"] = "utf-8"
    _SUBPROC_KW["errors"] = "replace"


def _read_env_var(name: str) -> str | None:
    if name in os.environ and os.environ[name].strip():
        return os.environ[name].strip()
    if not _ENV_FILE.is_file():
        return None
    for raw in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() == name:
            return value.strip()
    return None


def _database_url() -> str:
    return _read_env_var("DATABASE_URL") or _DEFAULT_URL


def _parse_url(url: str) -> tuple[str, int, str, str, str]:
    normalized = url.replace("postgresql+asyncpg", "postgresql").replace("postgresql+psycopg", "postgresql")
    parsed = urlparse(normalized)
    host = parsed.hostname or "localhost"
    port = parsed.port or 5432
    user = unquote(parsed.username or _APP_USER)
    password = unquote(parsed.password or _APP_PASSWORD)
    db = (parsed.path or f"/{_APP_DB}").lstrip("/") or _APP_DB
    return host, port, user, password, db


def _port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _wait_for_port(host: str, port: int, seconds: int) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if _port_open(host, port):
            return True
        time.sleep(1)
    return False


def _run(cmd: list[str], **extra) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=_ROOT, **_SUBPROC_KW, **extra)


def _windows_postgres_services() -> list[str]:
    try:
        result = _run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-Service -Name '*postgres*' -ErrorAction SilentlyContinue "
                "| Where-Object { $_.Name -like 'postgresql*' } "
                "| Select-Object -ExpandProperty Name",
            ],
            timeout=20,
        )
        return [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    except (OSError, subprocess.TimeoutExpired):
        return []


def _windows_postgres_data_dir() -> Path | None:
    for service in _windows_postgres_services():
        try:
            result = _run(["sc.exe", "qc", service], timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode != 0:
            continue
        text = result.stdout or ""
        dm = re.search(r'-D\s+"([^"]+)"', text, re.I) or re.search(r"-D\s+(\S+)", text, re.I)
        if dm:
            data = Path(dm.group(1).strip().strip('"'))
            if (data / "pg_hba.conf").is_file():
                return data
    return None


def _restart_postgres_service() -> bool:
    services = _windows_postgres_services()
    if not services:
        return False
    name = services[0]
    print(f"[db] Перезапуск службы {name} …", flush=True)
    for ps in (
        f"Restart-Service -Name '{name}' -Force -ErrorAction SilentlyContinue; "
        f"Start-Sleep -Seconds 3; (Get-Service -Name '{name}').Status",
        f"Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile','-Command',"
        f"'Restart-Service -Name ''{name}'' -Force; Start-Sleep 3')"
        f"; (Get-Service -Name '{name}').Status",
    ):
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
                cwd=_ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=180,
                check=False,
            )
            if "Running" in (result.stdout or ""):
                return True
        except (OSError, subprocess.TimeoutExpired):
            continue
    try:
        status = _run(
            ["powershell", "-NoProfile", "-Command", f"(Get-Service -Name '{name}').Status"],
            timeout=15,
        )
        return "Running" in (status.stdout or "")
    except (OSError, subprocess.TimeoutExpired):
        return False


def _start_postgres_service() -> None:
    if os.name != "nt":
        if sys.platform == "darwin":
            for cmd in (["brew", "services", "start", "postgresql@16"], ["brew", "services", "start", "postgresql"]):
                try:
                    if subprocess.run(cmd, capture_output=True, check=False).returncode == 0:
                        return
                except OSError:
                    continue
        else:
            for unit in ("postgresql", "postgresql-16", "postgresql@16-main"):
                try:
                    if subprocess.run(["systemctl", "start", unit], capture_output=True, check=False).returncode == 0:
                        return
                except OSError:
                    continue
        return

    services = _windows_postgres_services()
    if not services:
        print("[db] Служба PostgreSQL не найдена (postgresql-x64-*)", flush=True)
        return
    for name in services:
        print(f"[db] Запуск службы {name} …", flush=True)
        try:
            subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    f"Start-Service -Name '{name}' -ErrorAction SilentlyContinue",
                ],
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue


def _admin_creds() -> tuple[str, str]:
    user = _read_env_var("POSTGRES_ADMIN_USER") or "postgres"
    password = _read_env_var("POSTGRES_ADMIN_PASSWORD") or ""
    return user, password


async def _try_connect(host: str, port: int, user: str, password: str, database: str) -> bool:
    import asyncpg

    try:
        conn = await asyncpg.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database=database,
            timeout=8,
        )
        await conn.close()
        return True
    except Exception:
        return False


async def _ensure_inventory_with_admin(
    host: str, port: int, admin_user: str, admin_password: str
) -> tuple[bool, str]:
    import asyncpg

    try:
        conn = await asyncpg.connect(
            host=host,
            port=port,
            user=admin_user,
            password=admin_password,
            database="postgres",
            timeout=8,
        )
    except Exception as exc:
        return False, str(exc).strip()

    try:
        if admin_password:
            safe = admin_password.replace("'", "''")
            await conn.execute(f"ALTER USER {admin_user} WITH PASSWORD '{safe}'")

        await conn.execute(
            f"""
            DO $$ BEGIN
              IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{_APP_USER}') THEN
                CREATE ROLE {_APP_USER} LOGIN PASSWORD '{_APP_PASSWORD}';
              ELSE
                ALTER ROLE {_APP_USER} WITH LOGIN PASSWORD '{_APP_PASSWORD}';
              END IF;
            END $$;
            """
        )
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            _APP_DB,
        )
        if not exists:
            await conn.execute(
                f"CREATE DATABASE {_APP_DB} OWNER {_APP_USER} ENCODING 'UTF8'"
            )
            print(f"[db] Создана база {_APP_DB}", flush=True)
        await conn.execute(f"GRANT ALL PRIVILEGES ON DATABASE {_APP_DB} TO {_APP_USER}")
        return True, ""
    except Exception as exc:
        return False, str(exc).strip()
    finally:
        await conn.close()


def _enable_trust_local(pg_hba: Path) -> Path | None:
    backup = pg_hba.with_suffix(".conf.bak.corax")
    text = pg_hba.read_text(encoding="utf-8", errors="replace")
    if backup.exists():
        backup.write_text(text, encoding="utf-8")
    else:
        shutil.copy2(pg_hba, backup)

    lines: list[str] = []
    changed = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            lines.append(line)
            continue
        if re.search(r"127\.0\.0\.1/32|::1/128", line) and "scram-sha-256" in line:
            lines.append(re.sub(r"scram-sha-256|md5", "trust", line))
            changed = True
        else:
            lines.append(line)

    if not changed:
        return None
    pg_hba.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return backup


def _restore_pg_hba(backup: Path, pg_hba: Path) -> None:
    if backup.is_file():
        pg_hba.write_text(backup.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")


async def _bootstrap_windows_trust(host: str, port: int, admin_password: str) -> tuple[bool, str]:
    data_dir = _windows_postgres_data_dir()
    if not data_dir:
        return False, "не найден каталог данных PostgreSQL"

    pg_hba = data_dir / "pg_hba.conf"
    backup = _enable_trust_local(pg_hba)
    if backup is None:
        return False, "не удалось включить trust в pg_hba.conf"

    try:
        if not _restart_postgres_service():
            return False, "не удалось перезапустить PostgreSQL (нужны права администратора?)"
        if not _wait_for_port(host, port, 30):
            return False, "PostgreSQL не открыл порт после перезапуска"

        import asyncpg

        try:
            conn = await asyncpg.connect(host=host, port=port, user="postgres", database="postgres", timeout=8)
        except Exception as exc:
            return False, f"trust-подключение не удалось: {exc}"

        try:
            if admin_password:
                safe = admin_password.replace("'", "''")
                await conn.execute(f"ALTER USER postgres WITH PASSWORD '{safe}'")
                print("[db] Пароль postgres обновлён из POSTGRES_ADMIN_PASSWORD", flush=True)
        finally:
            await conn.close()

        ok, err = await _ensure_inventory_with_admin(host, port, "postgres", admin_password)
        if not ok:
            return False, err
        return True, ""
    finally:
        _restore_pg_hba(backup, pg_hba)
        _restart_postgres_service()
        _wait_for_port(host, port, 30)


async def _ensure_async(host: str, port: int, app_user: str, app_password: str, app_db: str) -> None:
    if await _try_connect(host, port, app_user, app_password, app_db):
        print(f"[db] PostgreSQL готов ({app_user}@{host}:{port}/{app_db})", flush=True)
        _maybe_migrate_sqlite(host, port, app_user, app_password, app_db)
        return

    admin_user, admin_password = _admin_creds()
    if not admin_password:
        _fail(
            host,
            port,
            "задайте POSTGRES_ADMIN_PASSWORD в backend/.env (пароль postgres при установке)",
        )

    print(f"[db] Инициализация БД через {admin_user} …", flush=True)
    ok, err = await _ensure_inventory_with_admin(host, port, admin_user, admin_password)
    if ok and await _try_connect(host, port, app_user, app_password, app_db):
        print(f"[db] PostgreSQL готов ({app_user}@{host}:{port}/{app_db})", flush=True)
        _maybe_migrate_sqlite(host, port, app_user, app_password, app_db)
        return

    if os.name == "nt" and (_read_env_var("ENVIRONMENT") or "development").lower() != "production":
        print("[db] Пароль postgres не подошёл — dev-bootstrap через trust (localhost) …", flush=True)
        ok, err = await _bootstrap_windows_trust(host, port, admin_password)
        if ok and await _try_connect(host, port, app_user, app_password, app_db):
            print(f"[db] PostgreSQL готов ({app_user}@{host}:{port}/{app_db})", flush=True)
            _maybe_migrate_sqlite(host, port, app_user, app_password, app_db)
            return
        if err:
            print(f"[db] bootstrap: {err}", flush=True)

    if "password authentication failed" in err.lower() or "password" in err.lower():
        _fail(
            host,
            port,
            "неверный POSTGRES_ADMIN_PASSWORD — укажите реальный пароль postgres или перезапустите start_all.bat от администратора для авто-настройки",
        )
    _fail(host, port, err or "не удалось создать пользователя/базу inventory")


def _maybe_migrate_sqlite(host: str, port: int, app_user: str, app_password: str, app_db: str) -> None:
    """Один раз переносит SQLite -> PostgreSQL, если в PG пусто, а .db файлы есть."""
    inv = _ROOT / "backend" / "inventory.db"
    if not inv.is_file():
        return
    try:
        import sqlite3

        sqlite_count = sqlite3.connect(inv).execute("SELECT COUNT(*) FROM computers").fetchone()[0]
        if not sqlite_count:
            return
        import asyncpg

        async def _check_and_migrate() -> None:
            conn = await asyncpg.connect(
                host=host, port=port, user=app_user, password=app_password, database=app_db
            )
            try:
                pg_count = await conn.fetchval("SELECT COUNT(*) FROM computers")
            finally:
                await conn.close()
            if pg_count and int(pg_count) > 0:
                return
            print("[db] SQLite inventory.db найден, PostgreSQL пуст — перенос данных …", flush=True)
            migrate_script = _ROOT / "scripts" / "migrate_sqlite_to_postgres.py"
            if not migrate_script.is_file():
                return
            import subprocess as sp

            sp.run([sys.executable, str(migrate_script)], cwd=_ROOT, check=False)
            sp.run([sys.executable, str(migrate_script), "--append"], cwd=_ROOT, check=False)

        asyncio.run(_check_and_migrate())
    except Exception as exc:
        print(f"[db] авто-миграция SQLite пропущена: {exc}", flush=True)


def _fail(host: str, port: int, reason: str) -> None:
    services = ", ".join(_windows_postgres_services()) if os.name == "nt" else "postgresql"
    svc = services.split(",")[0] if services else "postgresql-x64-16"
    msg = (
        f"\n[db] ОШИБКА: PostgreSQL на {host}:{port}.\n"
        f"Причина: {reason}\n\n"
        f"  • Служба: net start {svc}\n"
        "  • backend/.env → POSTGRES_ADMIN_PASSWORD=пароль postgres\n"
        "  • start_all.bat лучше запускать от администратора (один раз для авто-настройки)\n"
    )
    print(msg, file=sys.stderr, flush=True)
    raise SystemExit(1)


def ensure_postgres() -> None:
    url = _database_url()
    if not url.lower().startswith("postgresql"):
        return

    host, port, app_user, app_password, app_db = _parse_url(url)
    if host not in ("localhost", "127.0.0.1", "::1"):
        if asyncio.run(_try_connect(host, port, app_user, app_password, app_db)):
            print(f"[db] PostgreSQL доступен на {host}:{port}", flush=True)
        return

    if not _port_open(host, port):
        print(f"[db] PostgreSQL на {host}:{port} не слушает — запускаю службу …", flush=True)
        _start_postgres_service()
        if not _wait_for_port(host, port, _PORT_WAIT_SECONDS):
            _fail(host, port, "служба не поднялась")

    asyncio.run(_ensure_async(host, port, app_user, app_password, app_db))


if __name__ == "__main__":
    ensure_postgres()
