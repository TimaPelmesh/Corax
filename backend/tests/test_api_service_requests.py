from __future__ import annotations

import time
import zlib

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


def _wait_import(client: TestClient, auth_headers: dict[str, str]) -> dict:
    for _ in range(200):
        response = client.get("/api/v1/service-requests/import-status", headers=auth_headers)
        assert response.status_code == 200, response.text
        status = response.json()
        if not status["running"]:
            return status
        time.sleep(0.01)
    raise AssertionError("service-request import did not finish")


def test_service_requests_glpi_import_runs_in_background_and_is_idempotent(
    client: TestClient,
    auth_headers: dict[str, str],
):
    suffix = unique_hostname("glpi-import")
    glpi_id = 1_000_000_000 + zlib.crc32(suffix.encode("utf-8")) % 1_000_000_000
    csv_text = (
        "ID;Заголовок;Местоположение;Статус;Последнее изменение;"
        "Инициатор запроса - Инициатор запроса;Дата открытия;Приоритет;Категория\n"
        f"{glpi_id};{suffix};Office;Новая;16-08-2026 10:00;"
        "Tester;16-08-2026 09:00;Средний;IT\n"
    )

    started = client.post(
        "/api/v1/service-requests/import-glpi-csv",
        headers=auth_headers,
        files={"file": ("glpi.csv", csv_text.encode("utf-8"), "text/csv")},
    )
    assert started.status_code == 202, started.text
    first = _wait_import(client, auth_headers)
    assert first["phase"] == "done", first
    assert first["created"] == 1

    repeated = client.post(
        "/api/v1/service-requests/import-glpi-csv",
        headers=auth_headers,
        files={"file": ("glpi.csv", csv_text.encode("utf-8"), "text/csv")},
    )
    assert repeated.status_code == 202, repeated.text
    second = _wait_import(client, auth_headers)
    assert second["phase"] == "done", second
    assert second["created"] == 0
    assert second["updated"] == 0
    assert second["skipped"] == 1

    listed = client.get(
        "/api/v1/service-requests",
        headers=auth_headers,
        params={"q": suffix, "limit": 50},
    )
    assert listed.status_code == 200
    for item in listed.json()["items"]:
        if item["title"] == suffix:
            deleted = client.post(
                f"/api/v1/service-requests/{item['id']}/delete",
                headers=auth_headers,
            )
            assert deleted.status_code == 200


def test_service_requests_json_import_is_batched_and_restores_assignees(
    client: TestClient,
    auth_headers: dict[str, str],
):
    username = unique_hostname("json-import-user")
    user = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={"username": username, "password": "Assignee1!", "role": "editor"},
    )
    assert user.status_code == 200, user.text
    user_id = user.json()["id"]
    title = unique_hostname("json-import-ticket")

    started = client.post(
        "/api/v1/service-requests/import-json",
        headers=auth_headers,
        files={
            "file": (
                "tickets.json",
                (
                    '{"items":[{"title":"'
                    + title
                    + '","status":"open","priority":"normal","assignee_ids":['
                    + str(user_id)
                    + "]}]}"
                ).encode("utf-8"),
                "application/json",
            )
        },
    )
    assert started.status_code == 202, started.text
    status = _wait_import(client, auth_headers)
    assert status["phase"] == "done", status
    assert status["created"] == 1

    listed = client.get(
        "/api/v1/service-requests",
        headers=auth_headers,
        params={"q": title, "limit": 50},
    )
    assert listed.status_code == 200
    imported = next(item for item in listed.json()["items"] if item["title"] == title)
    assert imported["assignee_ids"] == [user_id]

    assert (
        client.post(
            f"/api/v1/service-requests/{imported['id']}/delete",
            headers=auth_headers,
        ).status_code
        == 200
    )
    client.post(f"/api/v1/users/{user_id}/delete", headers=auth_headers)


def test_service_requests_skip_and_bulk_fields(client: TestClient, auth_headers: dict[str, str]):
    created_ids: list[int] = []
    for idx in range(2):
        created = client.post(
            "/api/v1/service-requests",
            headers=auth_headers,
            json={
                "title": f"Skip page {idx} {unique_hostname('sr')}",
                "status": "open",
                "priority": "normal",
            },
        )
        assert created.status_code == 200, created.text
        created_ids.append(created.json()["id"])

    listed = client.get(
        "/api/v1/service-requests",
        headers=auth_headers,
        params={"limit": 1000},
    )
    assert listed.status_code == 200
    items = listed.json()["items"]
    assert items
    assert "created_by_username" in items[0]
    assert "assignee_ids" in items[0]
    ids = [item["id"] for item in items]
    for req_id in created_ids:
        assert req_id in ids
    assert ids == sorted(ids, reverse=True)

    older = created_ids[0]
    pos = ids.index(older)
    paged = client.get(
        "/api/v1/service-requests",
        headers=auth_headers,
        params={"limit": 1, "skip": pos},
    )
    assert paged.status_code == 200
    assert paged.json()["items"][0]["id"] == older
    assert paged.json()["total"] >= len(created_ids)

    for req_id in created_ids:
        client.post(f"/api/v1/service-requests/{req_id}/delete", headers=auth_headers)
