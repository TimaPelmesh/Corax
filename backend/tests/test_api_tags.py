from __future__ import annotations

from starlette.testclient import TestClient


def test_tags_list(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/tags", headers=auth_headers)
    assert r.status_code == 200
    assert isinstance(r.json(), list)
