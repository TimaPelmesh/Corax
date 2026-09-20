from __future__ import annotations

from unittest.mock import patch

from helpers import sample_inventory, unique_hostname
from starlette.testclient import TestClient


def _create_pc(client: TestClient, agent_headers: dict[str, str]) -> int:
    hn = unique_hostname()
    r = client.post("/api/v1/agent/inventory", json=sample_inventory(hn), headers=agent_headers)
    assert r.status_code == 200, r.text
    return int(r.json()["computer_id"])


def _observer_headers(client: TestClient, auth_headers: dict[str, str]) -> tuple[dict[str, str], int]:
    username = unique_hostname("wol-obs")
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
    login = client.post(
        "/api/v1/auth/login/json",
        json={"username": username, "password": "TestPass123!", "return_token": True},
    )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}, user_id


def test_wol_requires_auth(client: TestClient):
    # Session-scoped TestClient keeps login cookies; clear so CSRF does not mask 401.
    client.cookies.clear()
    assert client.get("/api/v1/computers/wol/config").status_code == 401
    assert client.post("/api/v1/computers/1/wake").status_code == 401


def test_wol_observer_cannot_wake_without_grant(
    client: TestClient,
    auth_headers: dict[str, str],
    agent_headers: dict[str, str],
):
    pc_id = _create_pc(client, agent_headers)
    obs, user_id = _observer_headers(client, auth_headers)
    try:
        assert client.get("/api/v1/computers/wol/config", headers=obs).status_code == 403
        client.put(
            "/api/v1/computers/wol/config",
            headers=auth_headers,
            json={"wake_user_ids": []},
        )
        denied = client.post(f"/api/v1/computers/{pc_id}/wake", headers=obs)
        assert denied.status_code == 403

        client.put(
            "/api/v1/computers/wol/config",
            headers=auth_headers,
            json={"wake_user_ids": [user_id]},
        )
        with patch("app.routers.computers.send_wake", return_value={"sent": 1, "errors": 0}):
            ok = client.post(f"/api/v1/computers/{pc_id}/wake", headers=obs)
        assert ok.status_code == 200, ok.text
    finally:
        client.put(
            "/api/v1/computers/wol/config",
            headers=auth_headers,
            json={"wake_user_ids": []},
        )
        client.post(f"/api/v1/users/{user_id}/delete", headers=auth_headers)
        client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)


def test_wol_superuser_wake_no_forced_cooldown(
    client: TestClient,
    auth_headers: dict[str, str],
    agent_headers: dict[str, str],
):
    pc_id = _create_pc(client, agent_headers)
    try:
        # Ensure pause is off (migration / default).
        client.put(
            "/api/v1/computers/wol/config",
            headers=auth_headers,
            json={"cooldown_seconds": 0, "wake_user_ids": []},
        )
        st = client.get(f"/api/v1/computers/{pc_id}/wol-status", headers=auth_headers)
        assert st.status_code == 200
        body = st.json()
        assert body["user_may_wake"] is True
        assert body["can_wake"] is True

        with patch("app.routers.computers.send_wake", return_value={"sent": 2, "errors": 0}):
            woke = client.post(f"/api/v1/computers/{pc_id}/wake", headers=auth_headers)
        assert woke.status_code == 200, woke.text
        assert woke.json()["ok"] is True

        # Immediate re-wake must work when cooldown is 0.
        with patch("app.routers.computers.send_wake", return_value={"sent": 2, "errors": 0}):
            again = client.post(f"/api/v1/computers/{pc_id}/wake", headers=auth_headers)
        assert again.status_code == 200, again.text
    finally:
        client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)


def test_wol_optional_cooldown_still_works(
    client: TestClient,
    auth_headers: dict[str, str],
    agent_headers: dict[str, str],
):
    pc_id = _create_pc(client, agent_headers)
    try:
        client.put(
            "/api/v1/computers/wol/config",
            headers=auth_headers,
            json={"cooldown_seconds": 120, "wake_user_ids": []},
        )
        with patch("app.routers.computers.send_wake", return_value={"sent": 2, "errors": 0}):
            assert client.post(f"/api/v1/computers/{pc_id}/wake", headers=auth_headers).status_code == 200
        again = client.post(f"/api/v1/computers/{pc_id}/wake", headers=auth_headers)
        assert again.status_code == 429
    finally:
        client.put(
            "/api/v1/computers/wol/config",
            headers=auth_headers,
            json={"cooldown_seconds": 0, "wake_user_ids": []},
        )
        client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)


def test_computer_ping_endpoint(
    client: TestClient,
    auth_headers: dict[str, str],
    agent_headers: dict[str, str],
):
    hn = unique_hostname()
    inv = sample_inventory(hn)
    inv["extended"] = {
        "network": {
            "adapters": [{"ipv4": ["10.20.30.40"], "gateway": "10.20.30.1"}],
        }
    }
    created = client.post("/api/v1/agent/inventory", json=inv, headers=agent_headers)
    assert created.status_code == 200, created.text
    pc_id = int(created.json()["computer_id"])
    try:
        with patch("app.routers.computers.ping_ip", return_value=True):
            r = client.post(f"/api/v1/computers/{pc_id}/ping", headers=auth_headers)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["checked"] is True
        assert body["online"] is True
        assert body["ip_address"] == "10.20.30.40"

        status = client.get("/api/v1/computers/ping-status", headers=auth_headers)
        assert status.status_code == 200, status.text
        items = status.json()["items"]
        mine = next(x for x in items if x["id"] == pc_id)
        assert mine["ping_status"] == "online"
        assert mine["ip_address"] == "10.20.30.40"
    finally:
        client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)


def test_wol_force_disabled_blocks_wake(
    client: TestClient,
    auth_headers: dict[str, str],
    agent_headers: dict[str, str],
    monkeypatch,
):
    from app.config import settings

    pc_id = _create_pc(client, agent_headers)
    monkeypatch.setattr(settings, "wol_force_disabled", True)
    try:
        denied = client.post(f"/api/v1/computers/{pc_id}/wake", headers=auth_headers)
        assert denied.status_code == 403
        assert "WOL_FORCE_DISABLED" in denied.json()["detail"] or "отключ" in denied.json()["detail"].lower()
    finally:
        monkeypatch.setattr(settings, "wol_force_disabled", False)
        client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)


def test_wol_wake_requires_mac(
    client: TestClient,
    auth_headers: dict[str, str],
    agent_headers: dict[str, str],
):
    hn = unique_hostname()
    inv = sample_inventory(hn)
    inv["mac_primary"] = None
    created = client.post("/api/v1/agent/inventory", json=inv, headers=agent_headers)
    assert created.status_code == 200, created.text
    pc_id = int(created.json()["computer_id"])
    try:
        r = client.post(f"/api/v1/computers/{pc_id}/wake", headers=auth_headers)
        assert r.status_code == 400
        assert "MAC" in r.json()["detail"]
    finally:
        client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)


def test_wol_config_cooldown_update(client: TestClient, auth_headers: dict[str, str]):
    before = client.get("/api/v1/computers/wol/config", headers=auth_headers)
    assert before.status_code == 200, before.text
    prev = int(before.json()["cooldown_seconds"])
    try:
        upd = client.put(
            "/api/v1/computers/wol/config",
            headers=auth_headers,
            json={"cooldown_seconds": 90, "wake_user_ids": []},
        )
        assert upd.status_code == 200, upd.text
        assert upd.json()["cooldown_seconds"] == 90
        assert isinstance(upd.json().get("wake_user_ids"), list)
    finally:
        client.put(
            "/api/v1/computers/wol/config",
            headers=auth_headers,
            json={"cooldown_seconds": prev, "wake_user_ids": []},
        )


def test_ping_sweep_requires_auth(client: TestClient):
    client.cookies.clear()
    assert client.post("/api/v1/computers/ping-sweep").status_code == 401
    assert client.get("/api/v1/computers/ping-status").status_code == 401
