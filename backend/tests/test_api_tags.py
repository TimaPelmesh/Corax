from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient


def test_tags_crud(client: TestClient, auth_headers: dict[str, str]):
    name = unique_hostname("tag")
    created = client.post(
        "/api/v1/tags",
        headers=auth_headers,
        json={"name": name, "color": "#ff5500"},
    )
    assert created.status_code == 200, created.text
    tag_id = created.json()["id"]
    assert created.json()["name"] == name

    listed = client.get("/api/v1/tags", headers=auth_headers)
    assert listed.status_code == 200
    assert any(t["id"] == tag_id for t in listed.json())

    patched = client.patch(
        f"/api/v1/tags/{tag_id}",
        headers=auth_headers,
        json={"name": f"{name}-v2", "color": "#00aa88"},
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == f"{name}-v2"

    deleted = client.delete(f"/api/v1/tags/{tag_id}", headers=auth_headers)
    assert deleted.status_code == 204
