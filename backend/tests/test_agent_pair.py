from __future__ import annotations

from starlette.testclient import TestClient

from app.routers.agent_pair import pairing_announce_kind


def test_pending_pairing_is_issued_without_panel_approval():
    from app.models import AgentPairing
    from app.routers.agent_pair import _ensure_pairing_token

    row = AgentPairing(public_id="pair-no-approval-0001", hostname="pc-waiting", status="pending")
    token, issued = _ensure_pairing_token(row)
    assert issued is not None
    assert token == row.token_once
    assert "." in token
    assert row.status == "approved"


def test_another_computer_gets_a_fresh_token_instead_of_the_first():
    assert pairing_announce_kind("claimed", "pc-1", "pc-2", False) == "fresh"
    assert pairing_announce_kind("approved", "pc-1", "PC-2", True) == "fresh"
    assert pairing_announce_kind("approved", "pc-1", "pc-1", True) == "reuse"
    assert pairing_announce_kind("claimed", "pc-1", "pc-1", False) == "fresh"


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
    assert after.json()["status"] == "approved"
    assert after.json()["agent_token"]
    assert after.json()["agent_token"] != token
