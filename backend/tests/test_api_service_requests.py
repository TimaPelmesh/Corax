from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient


def test_service_requests_crud(client: TestClient, auth_headers: dict[str, str]):
    title = f"Pytest заявка {unique_hostname('sr')}"
    created = client.post(
        "/api/v1/service-requests",
        headers=auth_headers,
        json={
            "title": title,
            "description": "Описание тестовой заявки",
            "status": "open",
            "priority": "normal",
            "category": "software",
        },
    )
    assert created.status_code == 200, created.text
    req_id = created.json()["id"]
    assert created.json()["title"] == title
    assert created.json().get("closed_at") in (None, "")
    # Открытая заявка не обязана иметь план/факт закрытия.
    assert created.json().get("planned_close_at") in (None, "")

    listed = client.get("/api/v1/service-requests", headers=auth_headers, params={"status": "open"})
    assert listed.status_code == 200
    assert listed.json()["total"] >= 1
    assert any(x["id"] == req_id for x in listed.json()["items"])

    patched = client.patch(
        f"/api/v1/service-requests/{req_id}",
        headers=auth_headers,
        json={"status": "in_progress", "priority": "high"},
    )
    assert patched.status_code == 200
    assert patched.json()["id"] == req_id
    assert patched.json()["status"] == "in_progress"

    listed_after = client.get("/api/v1/service-requests", headers=auth_headers, params={"limit": 50})
    assert listed_after.status_code == 200
    ids = [x["id"] for x in listed_after.json()["items"]]
    assert ids == sorted(ids, reverse=True)

    deleted = client.post(f"/api/v1/service-requests/{req_id}/delete", headers=auth_headers)
    assert deleted.status_code == 200


def test_service_request_open_with_assignees(client: TestClient, auth_headers: dict[str, str]):
    username = unique_hostname("assignee")
    user = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={"username": username, "password": "Assignee1!", "role": "editor"},
    )
    assert user.status_code == 200, user.text
    uid = user.json()["id"]

    created = client.post(
        "/api/v1/service-requests",
        headers=auth_headers,
        json={
            "title": f"Assigned {unique_hostname('sr')}",
            "status": "open",
            "priority": "normal",
            "assignee_ids": [uid],
            "planned_close_at": None,
            "closed_at": None,
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert uid in body["assignee_ids"]
    assert body["status"] == "open"
    assert body.get("closed_at") in (None, "")

    client.post(f"/api/v1/service-requests/{body['id']}/delete", headers=auth_headers)
    client.post(f"/api/v1/users/{uid}/delete", headers=auth_headers)


def test_service_request_templates(client: TestClient, auth_headers: dict[str, str]):
    title = f"Шаблон {unique_hostname('tpl')}"
    created = client.post(
        "/api/v1/service-requests/templates",
        headers=auth_headers,
        json={
            "title": title,
            "description": "Шаблон для pytest",
            "status": "open",
            "priority": "normal",
            "category": "hardware",
        },
    )
    assert created.status_code == 200, created.text
    tpl_id = created.json()["id"]

    listed = client.get("/api/v1/service-requests/templates", headers=auth_headers)
    assert listed.status_code == 200
    assert any(x["id"] == tpl_id for x in listed.json()["items"])

    patched = client.patch(
        f"/api/v1/service-requests/templates/{tpl_id}",
        headers=auth_headers,
        json={"priority": "low"},
    )
    assert patched.status_code == 200
    assert patched.json()["priority"] == "low"

    deleted = client.post(f"/api/v1/service-requests/templates/{tpl_id}/delete", headers=auth_headers)
    assert deleted.status_code == 200


def test_service_requests_export_pdf(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/service-requests/export-pdf", headers=auth_headers)
    assert r.status_code == 200
    assert r.content.startswith(b"%PDF")
