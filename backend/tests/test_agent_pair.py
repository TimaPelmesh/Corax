from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient

from app.routers.agent_pair import pairing_announce_kind


def test_pairing_announce_kind_waits_until_approved():
    assert pairing_announce_kind("claimed", "pc-1", "pc-2", False) == "fresh"
    assert pairing_announce_kind("approved", "pc-1", "PC-2", True) == "fresh"
    assert pairing_announce_kind("approved", "pc-1", "pc-1", True) == "reuse"
    assert pairing_announce_kind("claimed", "pc-1", "pc-1", False) == "wait"
    assert pairing_announce_kind("pending", "pc-1", "pc-1", False) == "wait"


def test_announce_waits_for_panel_approval(client: TestClient, auth_headers: dict[str, str]):
    public_id = unique_hostname("pair-pc-token").replace("_", "")[:32].ljust(16, "a")
    hostname = unique_hostname("pc-pair-auto")
    first = client.post(
        "/api/v1/agent/pair/announce",
        json={"public_id": public_id, "hostname": hostname},
    )
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["status"] == "pending"
    assert "agent_token" not in body or not body.get("agent_token")

    listed = client.get("/api/v1/agent-tokens", headers=auth_headers)
    assert listed.status_code == 200, listed.text
    assert not any(row["allowed_hostname"] == hostname for row in listed.json())

    pending = client.get("/api/v1/agent-tokens/pair/pending", headers=auth_headers)
    assert pending.status_code == 200, pending.text
    match = next(row for row in pending.json() if row["hostname"] == hostname)
    assert match["status"] == "pending"

    claimed = client.post("/api/v1/agent/pair/claim", json={"public_id": public_id})
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["status"] == "pending"
    assert not claimed.json().get("agent_token")

    approved = client.post(f"/api/v1/agent-tokens/pair/{match['id']}/approve", headers=auth_headers)
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"

    again = client.post(
        "/api/v1/agent/pair/announce",
        json={"public_id": public_id, "hostname": hostname},
    )
    assert again.status_code == 200, again.text
    assert again.json()["status"] == "approved"
    token = again.json()["agent_token"]
    assert "." in token

    tokens = client.get("/api/v1/agent-tokens", headers=auth_headers)
    issued = next(row for row in tokens.json() if row["allowed_hostname"] == hostname)
    assert issued["public_id_prefix"] == token.split(".", 1)[0]
    assert issued["revoked_at"] is None

    taken = client.post("/api/v1/agent/pair/claim", json={"public_id": public_id})
    assert taken.status_code == 200, taken.text
    assert taken.json()["status"] == "claimed"
    assert taken.json()["agent_token"] == token

    after = client.post(
        "/api/v1/agent/pair/announce",
        json={"public_id": public_id, "hostname": hostname},
    )
    assert after.status_code == 200, after.text
    assert after.json()["status"] == "pending"
    assert not after.json().get("agent_token")


def test_reject_pairing(client: TestClient, auth_headers: dict[str, str]):
    public_id = unique_hostname("pair-reject").replace("_", "")[:32].ljust(16, "a")
    hostname = unique_hostname("pc-reject")
    announced = client.post(
        "/api/v1/agent/pair/announce",
        json={"public_id": public_id, "hostname": hostname},
    )
    assert announced.status_code == 200, announced.text
    pending = client.get("/api/v1/agent-tokens/pair/pending", headers=auth_headers)
    match = next(row for row in pending.json() if row["hostname"] == hostname)
    rejected = client.post(f"/api/v1/agent-tokens/pair/{match['id']}/reject", headers=auth_headers)
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "rejected"
    claimed = client.post("/api/v1/agent/pair/claim", json={"public_id": public_id})
    assert claimed.json()["status"] == "rejected"
    assert not claimed.json().get("agent_token")
