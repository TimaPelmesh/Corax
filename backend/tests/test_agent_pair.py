from __future__ import annotations

from starlette.testclient import TestClient

from app.routers.agent_pair import pairing_announce_kind


def test_another_computer_gets_a_fresh_token_instead_of_the_first():
    assert pairing_announce_kind("claimed", "pc-1", "pc-2", False) == "fresh"
    assert pairing_announce_kind("approved", "pc-1", "PC-2", True) == "fresh"
    assert pairing_announce_kind("approved", "pc-1", "pc-1", True) == "reuse"
    assert pairing_announce_kind("claimed", "pc-1", "pc-1", False) == "claimed"


def test_announce_stores_token_before_claim(client: TestClient, auth_headers: dict[str, str]):
    public_id = "pair-pc-token-0001"
    hostname = "pc-pair-auto"
    first = client.post(
        "/api/v1/agent/pair/announce",
        json={"public_id": public_id, "hostname": hostname},
    )
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["status"] == "approved"
    token = body["agent_token"]
    assert "." in token

    again = client.post(
        "/api/v1/agent/pair/announce",
        json={"public_id": public_id, "hostname": hostname},
    )
    assert again.status_code == 200, again.text
    assert again.json()["agent_token"] == token

    listed = client.get("/api/v1/agent-tokens", headers=auth_headers)
    assert listed.status_code == 200, listed.text
    match = next(row for row in listed.json() if row["allowed_hostname"] == hostname)
    assert match["public_id_prefix"] == token.split(".", 1)[0]
    assert match["revoked_at"] is None

    claimed = client.post("/api/v1/agent/pair/claim", json={"public_id": public_id})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["status"] == "claimed"
    assert claimed.json()["agent_token"] == token

    after = client.post(
        "/api/v1/agent/pair/announce",
        json={"public_id": public_id, "hostname": hostname},
    )
    assert after.status_code == 200, after.text
    assert after.json()["status"] == "claimed"
    assert "agent_token" not in after.json()
