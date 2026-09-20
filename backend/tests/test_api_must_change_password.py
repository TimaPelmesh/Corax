from __future__ import annotations

import asyncio

import asyncpg
from starlette.testclient import TestClient

from app.config import settings
from app.password_change import PASSWORD_CHANGE_REQUIRED


def _dsn() -> str:
    return (settings.database_url or "").replace("postgresql+asyncpg://", "postgresql://", 1)


def _set_must_change(value: bool) -> None:
    async def _go() -> None:
        conn = await asyncpg.connect(_dsn())
        try:
            await conn.execute(
                "UPDATE users SET must_change_password = $1 WHERE username = 'admin'",
                value,
            )
        finally:
            await conn.close()

    asyncio.run(_go())


def test_must_change_password_blocks_api(client: TestClient, auth_headers: dict[str, str]):
    _set_must_change(True)
    try:
        blocked = client.get("/api/v1/computers", headers=auth_headers)
        assert blocked.status_code == 403, blocked.text
        assert blocked.json()["detail"] == PASSWORD_CHANGE_REQUIRED

        me = client.get("/api/v1/auth/me", headers=auth_headers)
        assert me.status_code == 200, me.text
        assert me.json()["must_change_password"] is True
    finally:
        _set_must_change(False)


def test_change_password_clears_must_change_flag(client: TestClient, auth_headers: dict[str, str]):
    _set_must_change(True)
    try:
        ok = client.post(
            "/api/v1/users/me/change-password",
            headers=auth_headers,
            json={"current_password": "admin123", "new_password": "AdminNew123"},
        )
        assert ok.status_code == 200, ok.text
        me = client.get("/api/v1/auth/me", headers=auth_headers)
        assert me.status_code == 200
        assert me.json()["must_change_password"] is False
        computers = client.get("/api/v1/computers", headers=auth_headers)
        assert computers.status_code == 200, computers.text
    finally:
        client.post(
            "/api/v1/users/me/change-password",
            headers=auth_headers,
            json={"current_password": "AdminNew123", "new_password": "admin123"},
        )
        _set_must_change(False)
