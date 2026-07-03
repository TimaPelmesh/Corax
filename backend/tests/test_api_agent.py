from __future__ import annotations

from starlette.testclient import TestClient

from helpers import sample_inventory, unique_hostname
from app.config import settings


def test_agent_inventory_requires_auth(client: TestClient):
    r = client.post("/api/v1/agent/inventory", json=sample_inventory())
    assert r.status_code == 401


def test_agent_inventory_rejects_bad_token(client: TestClient):
    body = sample_inventory()
    r = client.post(
        "/api/v1/agent/inventory",
        json=body,
        headers={"Authorization": "Bearer totally-wrong-token"},
    )
    assert r.status_code == 403


def test_agent_inventory_create_update_and_list(client: TestClient, agent_headers: dict[str, str], auth_headers: dict[str, str]):
    hn = unique_hostname()
    body = sample_inventory(hn)

    created = client.post("/api/v1/agent/inventory", json=body, headers=agent_headers)
    assert created.status_code == 200, created.text
    c_body = created.json()
    assert c_body["action"] == "created"
    assert c_body["hostname"] == hn
    computer_id = c_body["computer_id"]

    body["cpu"] = "Intel Core i7-12700"
    body["ram_gb"] = 32.0
    updated = client.post("/api/v1/agent/inventory", json=body, headers=agent_headers)
    assert updated.status_code == 200
    assert updated.json()["action"] == "updated"
    assert updated.json()["computer_id"] == computer_id

    detail = client.get(f"/api/v1/computers/{computer_id}", headers=auth_headers)
    assert detail.status_code == 200
    d = detail.json()
    assert d["hostname"] == hn
    assert d["cpu"] == "Intel Core i7-12700"
    assert d["ram_gb"] == 32.0
    assert d["software_count"] >= 2
    assert d["peripheral_count"] >= 2

    listed = client.get("/api/v1/computers", headers=auth_headers, params={"q": hn})
    assert listed.status_code == 200
    items = listed.json()["items"]
    assert any(x["id"] == computer_id for x in items)

    deleted = client.delete(f"/api/v1/computers/{computer_id}", headers=auth_headers)
    assert deleted.status_code == 204


def test_agent_inventory_with_created_token(client: TestClient, auth_headers: dict[str, str]):
    created = client.post(
        "/api/v1/agent-tokens",
        headers=auth_headers,
        json={"label": "pytest token"},
    )
    assert created.status_code == 200, created.text
    token = created.json()["token"]
    token_id = created.json()["id"]
    hn = unique_hostname("pytest-token-pc")

    r = client.post(
        "/api/v1/agent/inventory",
        json=sample_inventory(hn),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200

    pc_id = r.json()["computer_id"]
    client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)
    revoked = client.delete(f"/api/v1/agent-tokens/{token_id}", headers=auth_headers)
    assert revoked.status_code == 204


def test_agent_legacy_token(client: TestClient, auth_headers: dict[str, str]):
    token = (settings.agent_token or "").strip()
    hn = unique_hostname("legacy-pc")
    r = client.post(
        "/api/v1/agent/inventory",
        json=sample_inventory(hn),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200
    pc_id = r.json()["computer_id"]
    client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)
