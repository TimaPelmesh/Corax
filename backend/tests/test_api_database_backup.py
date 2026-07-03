from __future__ import annotations

from unittest.mock import patch

from starlette.testclient import TestClient


def test_database_status_requires_superuser(client: TestClient):
    client.cookies.clear()
    r = client.get("/api/v1/settings/database/status")
    assert r.status_code == 401


def test_database_status(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/settings/database/status", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["engine"] == "postgresql"
    assert "pg_dump_available" in body
    assert "counts" in body
    assert "users" in body["counts"]


@patch("app.routers.database_backup.create_database_dump", return_value=(b"PGDMP", "corax-test.dump"))
def test_database_export_mocked(mock_dump, client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/settings/database/export", headers=auth_headers)
    assert r.status_code == 200
    assert r.content == b"PGDMP"
    mock_dump.assert_called_once()

