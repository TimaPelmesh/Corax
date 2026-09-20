from __future__ import annotations

from types import SimpleNamespace

from app.migrations import _pg_try_execute


class _FakeResult:
    pass


class _FakeConn:
    def __init__(self, *, dialect: str, fail_on: str | None = None) -> None:
        self.dialect = SimpleNamespace(name=dialect)
        self.fail_on = fail_on
        self.calls: list[str] = []

    def execute(self, statement, *args, **kwargs):
        sql = str(getattr(statement, "text", statement)).strip()
        self.calls.append(sql)
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError(f"forced fail: {sql}")
        return _FakeResult()


def test_pg_try_execute_releases_savepoint_on_success():
    conn = _FakeConn(dialect="postgresql")
    assert _pg_try_execute(conn, "CREATE EXTENSION IF NOT EXISTS vector") is True
    assert conn.calls[0].startswith("SAVEPOINT")
    assert "CREATE EXTENSION IF NOT EXISTS vector" in conn.calls[1]
    assert conn.calls[2].startswith("RELEASE SAVEPOINT")


def test_pg_try_execute_rolls_back_savepoint_on_failure():
    conn = _FakeConn(dialect="postgresql", fail_on="CREATE EXTENSION")
    assert _pg_try_execute(conn, "CREATE EXTENSION IF NOT EXISTS vector") is False
    assert conn.calls[0].startswith("SAVEPOINT")
    assert any(c.startswith("ROLLBACK TO SAVEPOINT") for c in conn.calls)
    assert not any(c.startswith("RELEASE SAVEPOINT") for c in conn.calls)
