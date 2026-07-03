from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.pg_backup import (
    PgConn,
    configured_pg_bin_dir,
    create_database_dump,
    find_pg_executable,
    parse_database_url,
    pg_tools_status,
    restore_database_dump,
)


def test_parse_database_url_asyncpg():
    cfg = parse_database_url("postgresql+asyncpg://inventory:secret@localhost:5432/inventory")
    assert cfg.host == "localhost"
    assert cfg.port == 5432
    assert cfg.user == "inventory"
    assert cfg.password == "secret"
    assert cfg.dbname == "inventory"


def test_parse_database_url_postgresql_scheme():
    cfg = parse_database_url("postgresql://user:pass@db.example:5433/mydb")
    assert cfg.host == "db.example"
    assert cfg.port == 5433
    assert cfg.dbname == "mydb"


@patch("app.pg_backup._pg_bin_dir", return_value=None)
@patch("app.pg_backup.shutil.which")
def test_find_pg_executable_from_path(mock_which, _mock_bindir):
    mock_which.return_value = "/usr/bin/pg_dump"
    path = find_pg_executable("pg_dump")
    assert str(path).replace("\\", "/").endswith("/usr/bin/pg_dump")


@patch("app.pg_backup.find_pg_executable")
def test_pg_tools_status(mock_find):
    mock_find.side_effect = [
        MagicMock(__str__=lambda self: "/bin/pg_dump"),
        MagicMock(__str__=lambda self: "/bin/pg_restore"),
    ]
    status = pg_tools_status()
    assert status["pg_dump_available"] is True
    assert status["pg_restore_available"] is True


@patch("app.pg_backup.subprocess.run")
@patch("app.pg_backup.find_pg_executable")
@patch("app.pg_backup.Path.read_bytes", return_value=b"PGDMP")
@patch("app.pg_backup.tempfile.mkstemp", return_value=(99, "/tmp/test.dump"))
@patch("app.pg_backup.os.close")
@patch("app.pg_backup.Path.unlink")
def test_create_database_dump_success(mock_unlink, mock_close, mock_mkstemp, mock_read, mock_find, mock_run):
    mock_find.return_value = MagicMock(__str__=lambda self: "/bin/pg_dump")
    mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")

    data, filename = create_database_dump()
    assert data == b"PGDMP"
    assert filename.startswith("corax-inventory-")
    mock_run.assert_called_once()


@patch("app.pg_backup.subprocess.run")
@patch("app.pg_backup.find_pg_executable")
def test_create_database_dump_failure(mock_find, mock_run):
    mock_find.return_value = MagicMock(__str__=lambda self: "/bin/pg_dump")
    mock_run.return_value = MagicMock(returncode=1, stderr="boom", stdout="")

    with pytest.raises(RuntimeError, match="pg_dump"):
        create_database_dump()


def test_configured_pg_bin_dir_reads_settings(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "pg_bin_dir", "C:/pgsql/bin")
    assert configured_pg_bin_dir() == "C:/pgsql/bin"


@pytest.mark.asyncio
@patch("app.migrations.apply_migrations")
@patch("app.database.engine")
@patch("app.database.diagrams_engine")
@patch("app.database.warehouse_engine")
@patch("app.pg_backup._terminate_other_sessions")
@patch("app.pg_backup.subprocess.run")
@patch("app.pg_backup.find_pg_executable")
async def test_restore_database_dump_success(
    mock_find,
    mock_run,
    mock_terminate,
    mock_wh_engine,
    mock_diag_engine,
    mock_engine,
    mock_migrations,
):
    mock_find.return_value = MagicMock(__str__=lambda self: "/bin/pg_restore")
    mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")
    conn = MagicMock()
    conn.run_sync = AsyncMock(return_value=None)
    for eng in (mock_engine, mock_diag_engine, mock_wh_engine):
        eng.dispose = AsyncMock()
        ctx = MagicMock()
        ctx.__aenter__ = AsyncMock(return_value=conn)
        ctx.__aexit__ = AsyncMock(return_value=None)
        eng.begin.return_value = ctx

    result = await restore_database_dump(b"x" * 128)
    assert result["ok"] is True
    mock_terminate.assert_awaited_once()
