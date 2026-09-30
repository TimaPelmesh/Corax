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


def _login(client: TestClient, password: str) -> dict[str, str]:
    r = client.post(
        "/api/v1/auth/login/json",
        json={"username": "admin", "password": password, "return_token": True},
    )
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


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
    new_password = "AdminNew123"
    try:
        ok = client.post(
            "/api/v1/users/me/change-password",
            headers=auth_headers,
            json={"current_password": "admin123", "new_password": new_password},
        )
        assert ok.status_code == 200, ok.text
        # change-password bumps token_version — старый JWT больше не действует.
        headers = _login(client, new_password)
        me = client.get("/api/v1/auth/me", headers=headers)
        assert me.status_code == 200
        assert me.json()["must_change_password"] is False
        computers = client.get("/api/v1/computers", headers=headers)
        assert computers.status_code == 200, computers.text
    finally:
        # Password may still be admin123 if change failed before commit.
        try:
            headers = _login(client, new_password)
            current = new_password
        except AssertionError:
            headers = _login(client, "admin123")
            current = "admin123"
        if current != "admin123":
            restore = client.post(
                "/api/v1/users/me/change-password",
                headers=headers,
                json={"current_password": current, "new_password": "admin123"},
            )
            assert restore.status_code == 200, restore.text
        _set_must_change(False)
