from __future__ import annotations

from starlette.testclient import TestClient


def test_login_rejects_bad_password(client: TestClient):
    r = client.post(
        "/api/v1/auth/login/json",
        json={"username": "admin", "password": "wrong-password", "return_token": True},
    )
    assert r.status_code == 401


def test_login_and_me(client: TestClient):
    r = client.post(
        "/api/v1/auth/login/json",
        json={"username": "admin", "password": "admin123", "return_token": True},
    )
    assert r.status_code == 200
    token = r.json()["access_token"]
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    body = me.json()
    assert body["username"] == "admin"
    assert body["is_superuser"] is True


def test_me_requires_auth(client: TestClient):
    client.cookies.clear()
    r = client.get("/api/v1/auth/me")
    assert r.status_code == 401
