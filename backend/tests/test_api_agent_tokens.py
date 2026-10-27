from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient


def test_agent_tokens_list_create_revoke(client: TestClient, auth_headers: dict[str, str]):
    listed = client.get("/api/v1/agent-tokens", headers=auth_headers)
    assert listed.status_code == 200
    assert isinstance(listed.json(), list)

    created = client.post(
        "/api/v1/agent-tokens",
        headers=auth_headers,
        json={"label": unique_hostname("token-label")},
    )
    assert created.status_code == 200
    assert "token" in created.json()
    token_id = created.json()["id"]

    revoked = client.delete(f"/api/v1/agent-tokens/{token_id}", headers=auth_headers)
    assert revoked.status_code == 204


def test_agent_tokens_require_superuser(client: TestClient):
    client.cookies.clear()
    r = client.get("/api/v1/agent-tokens")
    assert r.status_code == 401


def test_revoke_all_agent_tokens(client: TestClient, auth_headers: dict[str, str]):
    first = client.post(
        "/api/v1/agent-tokens",
        headers=auth_headers,
        json={"label": unique_hostname("revoke-all-a")},
    )
    second = client.post(
        "/api/v1/agent-tokens",
        headers=auth_headers,
        json={"label": unique_hostname("revoke-all-b")},
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text

    wiped = client.post("/api/v1/agent-tokens/revoke-all", headers=auth_headers)
    assert wiped.status_code == 200, wiped.text
    assert wiped.json()["revoked"] >= 2

    listed = client.get("/api/v1/agent-tokens", headers=auth_headers)
    assert listed.status_code == 200
    assert listed.json() == []
