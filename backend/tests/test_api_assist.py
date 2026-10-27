from __future__ import annotations

from starlette.testclient import TestClient


def test_assist_start_requires_auth(client: TestClient):
    r = client.post("/api/v1/assist/sessions", json={"hostname": "PC-X"})
    assert r.status_code in (401, 403)


def test_assist_offer_reaches_agent(client: TestClient, auth_headers: dict[str, str], agent_headers: dict[str, str]):
    started = client.post("/api/v1/assist/sessions", json={"hostname": "PC-ASSIST-LAB"}, headers=auth_headers)
    assert started.status_code == 200, started.text
    body = started.json()
    assert body["hostname"] == "pc-assist-lab"
    assert body["status"] == "offered"
    pending = client.get("/api/v1/assist/pending?hostname=PC-ASSIST-LAB", headers=agent_headers)
    assert pending.status_code == 200, pending.text
    assert pending.json()["id"] == body["id"]
    denied = client.post(
        f"/api/v1/assist/sessions/{body['id']}/answer",
        json={"accept": False, "hostname": "PC-ASSIST-LAB"},
        headers=agent_headers,
    )
    assert denied.status_code == 200
    assert denied.json()["status"] == "denied"
