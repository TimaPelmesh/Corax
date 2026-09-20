from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, patch

from helpers import unique_hostname
from starlette.testclient import TestClient

from app.auth import can_access_panel
from app.models import User


def test_users_list_create_delete(client: TestClient, auth_headers: dict[str, str]):
    users = client.get("/api/v1/users", headers=auth_headers)
    assert users.status_code == 200
    assert any(u["username"] == "admin" for u in users.json())

    username = unique_hostname("user")
    created = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={
            "username": username,
            "password": "TestPass123!",
            "email": f"{username}@example.test",
            "is_superuser": False,
            "role": "observer",
        },
    )
    assert created.status_code == 200, created.text
    user_id = created.json()["id"]

    directory = client.get("/api/v1/users/directory", headers=auth_headers)
    assert directory.status_code == 200

    deleted = client.post(f"/api/v1/users/{user_id}/delete", headers=auth_headers)
    assert deleted.status_code == 200


def test_change_my_password(client: TestClient, auth_headers: dict[str, str]):
    bad = client.post(
        "/api/v1/users/me/change-password",
        headers=auth_headers,
        json={"current_password": "wrong", "new_password": "NewPass123"},
    )
    assert bad.status_code == 400

    ok = client.post(
        "/api/v1/users/me/change-password",
        headers=auth_headers,
        json={"current_password": "admin123", "new_password": "AdminNew123"},
    )
    assert ok.status_code == 200, ok.text

    login_new = client.post(
        "/api/v1/auth/login/json",
        json={"username": "admin", "password": "AdminNew123", "return_token": True},
    )
    assert login_new.status_code == 200, login_new.text

    restore = client.post(
        "/api/v1/users/me/change-password",
        headers={"Authorization": f"Bearer {login_new.json()['access_token']}"},
        json={"current_password": "AdminNew123", "new_password": "admin123"},
    )
    assert restore.status_code == 200


def test_admin_rename_service_account(client: TestClient, auth_headers: dict[str, str]):
    old_name = unique_hostname("rename-me")
    new_name = unique_hostname("renamed")
    created = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={
            "username": old_name,
            "password": "RenameMe1!",
            "is_superuser": False,
            "role": "observer",
        },
    )
    assert created.status_code == 200, created.text
    user_id = created.json()["id"]

    updated = client.patch(
        f"/api/v1/users/{user_id}",
        headers=auth_headers,
        json={"username": new_name, "full_name": "Renamed User"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["username"] == new_name
    assert updated.json()["full_name"] == "Renamed User"

    login = client.post(
        "/api/v1/auth/login/json",
        json={"username": new_name, "password": "RenameMe1!", "return_token": True},
    )
    assert login.status_code == 200, login.text

    client.post(f"/api/v1/users/{user_id}/delete", headers=auth_headers)


def test_directory_users_have_no_panel_access():
    ldap_user = User(
        username="ldap.user",
        hashed_password="x",
        is_active=True,
        is_superuser=False,
        role="directory",
        is_ldap=True,
    )
    assert can_access_panel(ldap_user) is False

    service_user = User(
        username="admin",
        hashed_password="x",
        is_active=True,
        is_superuser=True,
        role="editor",
        is_ldap=False,
    )
    assert can_access_panel(service_user) is True


@pytest.mark.asyncio
async def test_authenticate_user_rejects_directory_account():
    from app.auth import authenticate_user

    ldap_user = User(
        username="ldap.user",
        hashed_password="x",
        is_active=True,
        is_superuser=False,
        role="directory",
        is_ldap=True,
    )
    with patch("app.auth.get_user_by_username", new=AsyncMock(return_value=ldap_user)):
        result = await authenticate_user(AsyncMock(), "ldap.user", "any-password")
    assert result is None


def test_users_ldap_status(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/users/admin/ldap/status", headers=auth_headers)
    assert r.status_code == 200
    assert "configured" in r.json()
