from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient


def test_request_categories_tree_and_create(client: TestClient, auth_headers: dict[str, str]):
    tree = client.get("/api/v1/request-categories", headers=auth_headers)
    assert tree.status_code == 200
    assert isinstance(tree.json(), list)
    assert len(tree.json()) >= 1

    paths = client.get("/api/v1/request-categories/paths", headers=auth_headers)
    assert paths.status_code == 200
    assert isinstance(paths.json(), list)

    name = unique_hostname("cat")
    created = client.post(
        "/api/v1/request-categories",
        headers=auth_headers,
        json={"name": name},
    )
    assert created.status_code == 200, created.text
    cat_id = created.json()["id"]

    patched = client.patch(
        f"/api/v1/request-categories/{cat_id}",
        headers=auth_headers,
        json={"name": f"{name}-renamed"},
    )
    assert patched.status_code == 200

    deleted = client.delete(f"/api/v1/request-categories/{cat_id}", headers=auth_headers)
    assert deleted.status_code == 204
