from __future__ import annotations

from datetime import date, timedelta

from helpers import unique_hostname
from starlette.testclient import TestClient


def test_notes_create_share_acl_and_dates(client: TestClient, auth_headers: dict[str, str]):
    peer_name = unique_hostname("note-peer")
    peer = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={"username": peer_name, "password": "PeerPass1!", "role": "observer"},
    )
    assert peer.status_code == 200, peer.text
    peer_id = peer.json()["id"]

    start = date.today().isoformat()
    end = (date.today() + timedelta(days=7)).isoformat()
    created = client.post(
        "/api/v1/notes",
        headers=auth_headers,
        json={
            "title": "Plan cabin",
            "body_html": "<p>Migrate switches</p>",
            "plan_start": start,
            "plan_end": end,
        },
    )
    assert created.status_code == 200, created.text
    note = created.json()
    note_id = note["id"]
    assert note["title"] == "Plan cabin"
    assert note["can_edit"] is True
    assert note["is_owner"] is True
    assert note["plan_start"] == start

    # Peer cannot see before share
    peer_login = client.post(
        "/api/v1/auth/login/json",
        json={"username": peer_name, "password": "PeerPass1!", "return_token": True},
    )
    assert peer_login.status_code == 200
    peer_headers = {"Authorization": f"Bearer {peer_login.json()['access_token']}"}
    denied = client.get(f"/api/v1/notes/{note_id}", headers=peer_headers)
    assert denied.status_code == 404

    shared = client.put(
        f"/api/v1/notes/{note_id}/shares",
        headers=auth_headers,
        json={"shares": [{"user_id": peer_id, "can_edit": False}]},
    )
    assert shared.status_code == 200, shared.text
    assert len(shared.json()["shares"]) == 1

    viewed = client.get(f"/api/v1/notes/{note_id}", headers=peer_headers)
    assert viewed.status_code == 200
    assert viewed.json()["can_edit"] is False
    assert viewed.json()["title"] == "Plan cabin"

    # Read-only cannot patch
    bad_edit = client.patch(
        f"/api/v1/notes/{note_id}",
        headers=peer_headers,
        json={"title": "Hacked"},
    )
    assert bad_edit.status_code == 403

    # Grant edit
    client.put(
        f"/api/v1/notes/{note_id}/shares",
        headers=auth_headers,
        json={"shares": [{"user_id": peer_id, "can_edit": True}]},
    )
    ok_edit = client.patch(
        f"/api/v1/notes/{note_id}",
        headers=peer_headers,
        json={"body_html": "<p>Updated</p>"},
    )
    assert ok_edit.status_code == 200, ok_edit.text
    assert "Updated" in ok_edit.json()["body_html"]

    # Appears on dashboard for owner
    dash = client.get("/api/v1/dashboard/summary", headers=auth_headers)
    assert dash.status_code == 200
    upcoming = dash.json().get("upcoming_notes") or []
    assert any(x["id"] == note_id for x in upcoming)

    # Peer sees it too
    dash_peer = client.get("/api/v1/dashboard/summary", headers=peer_headers)
    assert any(x["id"] == note_id for x in (dash_peer.json().get("upcoming_notes") or []))

    client.delete(f"/api/v1/notes/{note_id}", headers=auth_headers)
    client.post(f"/api/v1/users/{peer_id}/delete", headers=auth_headers)


def test_notes_invalid_plan_dates(client: TestClient, auth_headers: dict[str, str]):
    r = client.post(
        "/api/v1/notes",
        headers=auth_headers,
        json={
            "title": "Bad dates",
            "plan_start": (date.today() + timedelta(days=5)).isoformat(),
            "plan_end": date.today().isoformat(),
        },
    )
    assert r.status_code == 400
