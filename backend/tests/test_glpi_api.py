from __future__ import annotations

import json
import secrets
from urllib.parse import parse_qs

import httpx
import pytest
from helpers import unique_hostname
from starlette.testclient import TestClient

from app.glpi_client import (
    GlpiClientError,
    GlpiCredentials,
    GlpiOutbound,
    GlpiTicket,
    fetch_tickets,
    normalize_base_url,
    parse_ticket,
    probe_glpi,
    push_tickets,
)
def _v2_creds(**overrides: object) -> GlpiCredentials:
    data: dict[str, object] = {
        "base_url": "http://glpi.local/glpi",
        "api_mode": "v2",
        "grant_type": "password",
        "client_id": "corax-client",
        "client_secret": "sekret-value",
        "username": "glpi",
        "password": "pw-secret-99",
        "verify_tls": False,
    }
    data.update(overrides)
    return GlpiCredentials(**data)  # type: ignore[arg-type]


def _legacy_creds() -> GlpiCredentials:
    return GlpiCredentials(
        base_url="http://10.0.0.5/glpi/apirest.php",
        api_mode="legacy",
        app_token="app-secret-11",
        user_token="user-secret-22",
        verify_tls=False,
    )


def test_normalize_base_url_strips_api_suffix_and_adds_http():
    assert normalize_base_url("http://glpi.local/glpi/api.php/v2/doc") == "http://glpi.local/glpi"
    assert normalize_base_url("http://glpi.local/glpi/apirest.php/initSession") == "http://glpi.local/glpi"
    assert normalize_base_url("192.168.1.20/glpi") == "http://192.168.1.20/glpi"
    with pytest.raises(GlpiClientError):
        normalize_base_url("")
    with pytest.raises(GlpiClientError):
        normalize_base_url("ftp://glpi.local")


def test_parse_ticket_maps_html_status_and_priority():
    ticket = parse_ticket(
        {
            "id": "15",
            "name": "Принтер",
            "content": "Замятие<br>бумаги",
            "status": {"id": 2, "name": "Processing (assigned)"},
            "priority": 5,
            "date": "2026-01-02 10:00:00",
            "date_mod": "2026-01-03 11:00:00",
            "category": {"id": 3, "name": "Печать"},
            "location": {"id": 4, "name": "Каб. 12"},
            "user_recipient": {"id": 9, "name": "Иванов"},
        },
        base_url="http://glpi.local/glpi",
    )
    assert ticket is not None
    assert ticket.glpi_id == 15
    assert ticket.status == "in_progress"
    assert ticket.priority == "high"
    assert ticket.content == "Замятие\nбумаги"
    assert ticket.requester == "Иванов"
    assert ticket.category == "Печать"
    assert ticket.location == "Каб. 12"
    assert ticket.url == "http://glpi.local/glpi/front/ticket.form.php?id=15"
    assert ticket.closed_at is None


def test_v2_password_grant_lists_tickets_and_stops_on_short_page():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api.php/token"):
            form = parse_qs(request.content.decode())
            assert form["grant_type"] == ["password"]
            assert form["client_secret"] == ["sekret-value"]
            assert form["username"] == ["glpi"]
            return httpx.Response(200, json={"access_token": "atk", "token_type": "Bearer", "expires_in": 3600})
        if request.url.path.endswith("/Assistance/Ticket") and request.method == "GET":
            assert request.headers["authorization"] == "Bearer atk"
            start = int(request.url.params.get("start", "0"))
            if start == 0:
                return httpx.Response(
                    200,
                    json=[{"id": index, "name": f"t{index}", "status": 1, "priority": 3} for index in range(1, 101)],
                )
            if start == 100:
                return httpx.Response(
                    200,
                    json=[{"id": 101, "name": "last", "status": 6, "priority": 1, "date_close": "2026-02-01 12:00:00"}],
                )
            return httpx.Response(200, json=[])
        return httpx.Response(404, json={"message": request.url.path})

    tickets = fetch_tickets(_v2_creds(), 150, transport=httpx.MockTransport(handler))
    assert len(tickets) == 101
    assert tickets[0].status == "open"
    assert tickets[0].priority == "normal"
    assert tickets[-1].glpi_id == 101
    assert tickets[-1].status == "done"
    assert tickets[-1].priority == "low"
    assert tickets[-1].closed_at is not None


def test_list_does_not_loop_when_glpi_repeats_a_page():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        page = [{"id": 1, "name": "only", "status": 1, "priority": 3}] * 100
        return httpx.Response(200, json=page)

    tickets = fetch_tickets(_v2_creds(), 500, transport=httpx.MockTransport(handler))
    assert [item.glpi_id for item in tickets] == [1]


def test_client_credentials_omits_user_and_retries_json_body():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if not request.url.path.endswith("/token"):
            return httpx.Response(200, json=[])
        content_type = request.headers.get("content-type", "")
        calls.append(content_type)
        if content_type.startswith("application/json"):
            body = json.loads(request.content.decode())
            assert body["grant_type"] == "client_credentials"
            assert "username" not in body
            assert "password" not in body
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        return httpx.Response(415, text="use json")

    result = probe_glpi(
        _v2_creds(grant_type="client_credentials", username="", password=""),
        transport=httpx.MockTransport(handler),
    )
    assert result.ok is True
    assert result.tickets_visible == 0
    assert result.api_mode == "v2"
    assert any(item.startswith("application/json") for item in calls)


def test_oauth_error_does_not_echo_secret():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"error": "invalid_client", "error_description": "rejected sekret-value"},
        )

    with pytest.raises(GlpiClientError) as caught:
        probe_glpi(_v2_creds(), transport=httpx.MockTransport(handler))
    message = str(caught.value)
    assert "sekret-value" not in message
    assert "Client secret" in message


def test_legacy_session_lists_and_creates():
    created: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/initSession"):
            assert request.headers["app-token"] == "app-secret-11"
            assert request.headers["authorization"] == "user_token user-secret-22"
            return httpx.Response(200, json={"session_token": "sess-1"})
        if request.url.path.endswith("/getFullSession"):
            return httpx.Response(200, json={"cfg_glpi": {"version": "10.0.18"}})
        if request.url.path.endswith("/killSession"):
            assert request.headers["session-token"] == "sess-1"
            return httpx.Response(200, json=[True])
        if request.method == "GET" and request.url.path.endswith("/Ticket"):
            assert request.headers["session-token"] == "sess-1"
            return httpx.Response(200, json=[{"id": 7, "name": "Старая", "status": 4, "priority": 2, "content": "ok"}])
        if request.method == "POST" and request.url.path.endswith("/Ticket"):
            created.update(json.loads(request.content.decode()))
            return httpx.Response(201, json={"id": 70, "message": ""})
        return httpx.Response(404, json=["ERROR", request.url.path])

    transport = httpx.MockTransport(handler)
    probe = probe_glpi(_legacy_creds(), transport=transport)
    assert probe.version == "10.0.18"
    assert probe.api_mode == "legacy"
    tickets = fetch_tickets(_legacy_creds(), 10, transport=transport)
    assert tickets[0].glpi_id == 7
    assert tickets[0].status == "in_progress"
    assert tickets[0].priority == "low"
    results = push_tickets(
        _legacy_creds(),
        [GlpiOutbound(corax_id=4, glpi_id=None, title="Новая", content="текст", status="open", priority="low")],
        transport=transport,
    )
    assert results[0].action == "created"
    assert results[0].glpi_id == 70
    assert created["input"]["external_id"] == "corax:4"
    assert created["input"]["status"] == 1
    assert created["input"]["priority"] == 2


def test_v2_push_create_then_update():
    bodies: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        if request.url.path.endswith("/Assistance/Ticket") and request.method == "POST":
            body = json.loads(request.content.decode())
            bodies.append(("POST", body))
            return httpx.Response(201, json={"id": 55})
        if request.method == "PATCH":
            body = json.loads(request.content.decode())
            bodies.append(("PATCH", body))
            return httpx.Response(200, json={"id": 55, "status": body["status"]})
        return httpx.Response(404, json={"message": "nope"})

    results = push_tickets(
        _v2_creds(),
        [
            GlpiOutbound(corax_id=9, glpi_id=None, title="Новая", content="текст", status="open", priority="high"),
            GlpiOutbound(corax_id=9, glpi_id=55, title="Новая", content="ещё", status="done", priority="high"),
        ],
        transport=httpx.MockTransport(handler),
    )
    assert [(item.action, item.glpi_id) for item in results] == [("created", 55), ("updated", 55)]
    assert "input" not in bodies[0][1]
    assert bodies[0][1]["priority"] == 4
    assert bodies[0][1]["status"] == 1
    assert bodies[1][1]["status"] == 5


def test_glpi_settings_require_auth(client: TestClient):
    response = client.get("/api/v1/settings/glpi")
    assert response.status_code in (401, 403)


def test_glpi_settings_keep_secrets_off_the_wire(client: TestClient, auth_headers: dict[str, str]):
    secret = "sekret-value"
    password = "pw-secret-99"
    saved = client.put(
        "/api/v1/settings/glpi",
        headers=auth_headers,
        json={
            "enabled": True,
            "base_url": "http://glpi.local/glpi/api.php",
            "api_mode": "v2",
            "grant_type": "password",
            "client_id": "corax-client",
            "client_secret": secret,
            "username": "glpi",
            "password": password,
            "app_token": "app-secret-11",
            "user_token": "user-secret-22",
            "verify_tls": False,
        },
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["client_secret_set"] is True
    assert body["password_set"] is True
    assert body["app_token_set"] is True
    assert body["user_token_set"] is True
    assert body["base_url"] == "http://glpi.local/glpi/api.php"
    assert secret not in saved.text
    assert password not in saved.text
    assert "app-secret-11" not in saved.text
    assert "user-secret-22" not in saved.text

    again = client.put(
        "/api/v1/settings/glpi",
        headers=auth_headers,
        json={"client_id": "corax-client", "client_secret": "", "password": ""},
    )
    assert again.status_code == 200, again.text
    assert again.json()["client_secret_set"] is True
    assert again.json()["password_set"] is True
    assert secret not in again.text

    fetched = client.get("/api/v1/settings/glpi", headers=auth_headers)
    assert fetched.status_code == 200
    assert fetched.json()["client_secret_set"] is True
    assert "client_secret" not in fetched.json()
    assert secret not in fetched.text

    rejected = client.put(
        "/api/v1/settings/glpi",
        headers=auth_headers,
        json={"api_mode": "graphql"},
    )
    assert rejected.status_code == 400


def test_glpi_import_export_roundtrip(client: TestClient, auth_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch):
    title = f"GLPI API {unique_hostname('glpi')}"
    glpi_id = 8_000_000 + secrets.randbelow(1_000_000_000)

    def fake_fetch(creds, limit=200, transport=None):
        return [
            GlpiTicket(
                glpi_id=glpi_id,
                title=title,
                content="Бумага\nкончилась",
                status="in_progress",
                priority="high",
                status_label="Processing (assigned)",
                priority_label="Very high",
                updated_at=None,
                opened_at=None,
                closed_at=None,
                requester="Иванов",
                category="Печать",
                location="Каб. 12",
                url=f"http://glpi.local/glpi/front/ticket.form.php?id={glpi_id}",
            )
        ]

    monkeypatch.setattr("app.glpi_sync.fetch_tickets", fake_fetch)
    saved = client.put(
        "/api/v1/settings/glpi",
        headers=auth_headers,
        json={"enabled": True, "base_url": "http://glpi.local/glpi", "api_mode": "v2", "verify_tls": False},
    )
    assert saved.status_code == 200, saved.text

    imported = client.post(
        "/api/v1/settings/glpi/import-tickets",
        headers=auth_headers,
        json={"limit": 10},
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["created"] == 1

    listed = client.get("/api/v1/service-requests", headers=auth_headers, params={"limit": 30})
    assert listed.status_code == 200
    match = next(item for item in listed.json()["items"] if item["title"] == title)
    assert match["glpi_id"] == glpi_id
    assert match["status"] == "in_progress"
    assert match["priority"] == "high"
    assert match["requester_name"] == "Иванов"
    assert match["description"] == "Бумага\nкончилась"
    assert match["external_source"] == "glpi"
    request_id = match["id"]

    again = client.post(
        "/api/v1/settings/glpi/import-tickets",
        headers=auth_headers,
        json={"limit": 10},
    )
    assert again.status_code == 200, again.text
    assert again.json()["created"] == 0
    assert again.json()["skipped"] == 1

    pushed: list[GlpiOutbound] = []

    def fake_push(creds, items, transport=None):
        pushed.extend(items)
        return [
            type("R", (), {"corax_id": item.corax_id, "glpi_id": 4242, "action": "created", "error": None})()
            for item in items
        ]

    monkeypatch.setattr("app.glpi_sync.push_tickets", fake_push)
    created = client.post(
        "/api/v1/service-requests",
        headers=auth_headers,
        json={"title": f"{title} out", "description": "Наружу", "status": "open", "priority": "low"},
    )
    assert created.status_code == 200, created.text
    outbound_id = created.json()["id"]

    exported = client.post(
        "/api/v1/settings/glpi/export-tickets",
        headers=auth_headers,
        json={"limit": 5, "request_ids": [outbound_id]},
    )
    assert exported.status_code == 200, exported.text
    assert exported.json()["created"] == 1
    assert exported.json()["failed"] == 0
    assert len(pushed) == 1
    assert pushed[0].corax_id == outbound_id
    assert pushed[0].glpi_id is None
    assert pushed[0].priority == "low"
    assert pushed[0].content == "Наружу"

    listed_after = client.get("/api/v1/service-requests", headers=auth_headers, params={"limit": 30})
    outbound = next(item for item in listed_after.json()["items"] if item["id"] == outbound_id)
    assert outbound["glpi_id"] == 4242
    assert outbound["external_url"].endswith("/front/ticket.form.php?id=4242")
    assert outbound["glpi_priority"] == "Low"
    assert request_id != outbound_id


def test_glpi_import_requires_enabled_connection(client: TestClient, auth_headers: dict[str, str]):
    saved = client.put(
        "/api/v1/settings/glpi",
        headers=auth_headers,
        json={"enabled": False, "base_url": "http://glpi.local/glpi"},
    )
    assert saved.status_code == 200, saved.text
    denied = client.post("/api/v1/settings/glpi/import-tickets", headers=auth_headers, json={"limit": 1})
    assert denied.status_code == 400


def test_glpi_test_stores_failure_without_secret(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    def explode(creds, transport=None):
        raise GlpiClientError("GLPI не принял Client ID или Client secret.")

    monkeypatch.setattr("app.routers.settings.probe_glpi", explode)
    response = client.post("/api/v1/settings/glpi/test", headers=auth_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert "Client secret" in body["message"]
    assert "sekret-value" not in response.text
