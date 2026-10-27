from __future__ import annotations

from starlette.testclient import TestClient


def test_monitors_list(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/monitors", headers=auth_headers)
    assert r.status_code == 200
    assert isinstance(r.json(), list)
