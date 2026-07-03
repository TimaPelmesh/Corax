from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient


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


def test_users_ldap_status(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/users/admin/ldap/status", headers=auth_headers)
    assert r.status_code == 200
    assert "configured" in r.json()
