from __future__ import annotations

import json
import secrets
from dataclasses import replace
from urllib.parse import parse_qs

import httpx
import pytest
from helpers import unique_hostname
from starlette.testclient import TestClient

from app.glpi_client import (
    GlpiAssetPushResult,
    GlpiClientError,
    GlpiComputer,
    GlpiComputerOutbound,
    GlpiCredentials,
    GlpiOutbound,
    GlpiSoftware,
    GlpiTicket,
    canonical_software,
    fetch_computers,
    fetch_tickets,
    normalize_base_url,
    parse_computer,
    parse_ticket,
    probe_glpi,
    push_computers,
    push_tickets,
    same_software_set,
    software_key,
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
    assert "CORAX #4" in created["input"]["content"]
    assert "external_id" not in created["input"]
    assert created["input"]["status"] == 1
    assert created["input"]["priority"] == 2


def test_probe_reads_active_profile_from_full_session():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/initSession"):
            return httpx.Response(200, json={"session_token": "sess-1"})
        if request.url.path.endswith("/getFullSession"):
            return httpx.Response(
                200,
                json={
                    "session": {
                        "glpiID": 42,
                        "glpiname": "helpdesk",
                        "glpifirstname": "Иван",
                        "glpirealname": "Петров",
                        "glpiactiveprofile": {"id": 4, "name": "Technician"},
                        "glpiactive_entity_name": "Root entity",
                    },
                    "cfg_glpi": {"version": "10.0.18"},
                },
            )
        if request.url.path.endswith("/killSession"):
            return httpx.Response(200, json=[True])
        if request.method == "GET" and request.url.path.endswith("/Ticket"):
            return httpx.Response(200, json=[])
        return httpx.Response(404, json=["ERROR", request.url.path])

    probe = probe_glpi(_legacy_creds(), transport=httpx.MockTransport(handler))
    assert probe.ok is True
    assert probe.identity is not None
    assert probe.identity.username == "helpdesk"
    assert probe.identity.display_name == "Иван Петров"
    assert probe.identity.profile == "Technician"
    assert probe.identity.entity == "Root entity"
    assert "Technician" in probe.message


def test_create_test_ticket_uses_corax_test_external_id():
    created: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/initSession"):
            return httpx.Response(200, json={"session_token": "sess-1"})
        if request.url.path.endswith("/getFullSession"):
            return httpx.Response(
                200,
                json={
                    "session": {
                        "glpiID": 7,
                        "glpiname": "glpi",
                        "glpiactiveprofile": {"name": "Super-Admin"},
                    },
                    "cfg_glpi": {"version": "10.0.18"},
                },
            )
        if request.url.path.endswith("/killSession"):
            return httpx.Response(200, json=[True])
        if request.method == "POST" and request.url.path.endswith("/Ticket"):
            created.update(json.loads(request.content.decode()))
            return httpx.Response(201, json={"id": 901})
        return httpx.Response(404, json=["ERROR", request.url.path])

    from app.glpi_client import create_test_ticket

    result = create_test_ticket(
        _legacy_creds(),
        title="Проверка",
        content="тест",
        transport=httpx.MockTransport(handler),
    )
    assert result.ok is True
    assert result.glpi_id == 901
    assert result.url and result.url.endswith("id=901")
    assert result.identity is not None
    assert result.identity.profile == "Super-Admin"
    assert "external_id" not in created["input"]
    assert created["input"]["name"] == "Проверка"
    assert created["input"]["content"] == "тест"


def test_upsert_matches_by_title_instead_of_duplicating():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/initSession"):
            return httpx.Response(200, json={"session_token": "sess-1"})
        if path.endswith("/getFullSession"):
            return httpx.Response(200, json={"cfg_glpi": {"version": "10.0.18"}})
        if path.endswith("/killSession"):
            return httpx.Response(200, json=[True])
        if request.method == "GET" and path.endswith("/Ticket"):
            calls.append("search")
            return httpx.Response(
                200,
                json=[{"id": 77, "name": "Принтер не печатает", "status": 1, "priority": 3}],
            )
        if request.method == "PUT" and path.endswith("/Ticket/77"):
            calls.append("update")
            return httpx.Response(200, json={"id": 77})
        if request.method == "POST" and path.endswith("/Ticket"):
            calls.append("create")
            return httpx.Response(201, json={"id": 999})
        return httpx.Response(404, json=["ERROR", path])

    results = push_tickets(
        _legacy_creds(),
        [
            GlpiOutbound(
                corax_id=5,
                glpi_id=None,
                title="Принтер не печатает",
                content="детали",
                status="open",
                priority="normal",
            )
        ],
        transport=httpx.MockTransport(handler),
    )
    assert results[0].action == "updated"
    assert results[0].glpi_id == 77
    assert "create" not in calls
    assert "update" in calls


def test_upsert_creates_when_stale_link_has_no_update_rights_and_title_missing():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/initSession"):
            return httpx.Response(200, json={"session_token": "sess-1"})
        if path.endswith("/getFullSession"):
            return httpx.Response(200, json={"cfg_glpi": {"version": "10.0.18"}})
        if path.endswith("/killSession"):
            return httpx.Response(200, json=[True])
        if request.method == "PUT" and path.endswith("/Ticket/158"):
            return httpx.Response(403, json=["ERROR_RIGHT", "You don't have permission to perform this action."])
        if request.method == "GET" and path.endswith("/Ticket"):
            return httpx.Response(200, json=[])
        if request.method == "POST" and path.endswith("/Ticket"):
            return httpx.Response(201, json={"id": 9001})
        return httpx.Response(404, json=["ERROR", path])

    results = push_tickets(
        _legacy_creds(),
        [
            GlpiOutbound(
                corax_id=458,
                glpi_id=158,
                title="Уникальная тема CORAX",
                content="текст",
                status="open",
                priority="normal",
            )
        ],
        transport=httpx.MockTransport(handler),
    )
    assert results[0].action == "created"
    assert results[0].glpi_id == 9001
    assert results[0].detail and "старая связь" in results[0].detail


def test_friendly_permission_message_is_actionable():
    from app.glpi_client import _friendly

    text = _friendly("You don't have permission to perform this action.")
    assert "прав" in text.casefold() or "Нет прав" in text
    assert "UPDATE" in text or "CREATE" in text
    assert "sekret" not in text


def test_outbound_body_maps_corax_statuses_for_glpi():
    from app.glpi_client import GlpiOutbound, _outbound_body, glpi_priority_id, glpi_status_id

    assert glpi_status_id("open") == 1
    assert glpi_status_id("in_progress") == 2
    assert glpi_status_id("done") == 5
    assert glpi_status_id("cancelled") == 6
    assert glpi_priority_id("low") == 2
    assert glpi_priority_id("normal") == 3
    assert glpi_priority_id("high") == 4
    body = _outbound_body(
        GlpiOutbound(corax_id=12, glpi_id=None, title="Тема", content="Текст", status="open", priority="normal")
    )
    assert body["status"] == 1
    assert body["priority"] == 3
    assert body["type"] == 1
    assert "[CORAX #12]" in body["content"]
    assert "external_id" not in body
    closed = _outbound_body(
        GlpiOutbound(
            corax_id=13,
            glpi_id=50,
            title="Закрыта",
            content="готово",
            status="done",
            priority="high",
            requester="Иван",
            assignee="Петр",
            category="Сеть",
        ),
        for_update=True,
    )
    assert closed["status"] == 5
    assert closed["priority"] == 4
    empty_update = _outbound_body(
        GlpiOutbound(corax_id=14, glpi_id=51, title="X", content="", status="done", priority="normal"),
        for_update=True,
    )
    assert "content" not in empty_update


def test_create_ticket_keeps_requester_assignee_category_when_closed():
    posts: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/initSession"):
            return httpx.Response(200, json={"session_token": "sess-1"})
        if path.endswith("/getFullSession"):
            return httpx.Response(200, json={"cfg_glpi": {"version": "10.0.18"}})
        if path.endswith("/killSession"):
            return httpx.Response(200, json=[True])
        if request.method == "GET" and "ITILCategory" in path:
            return httpx.Response(200, json=[{"id": 9, "name": "Сеть"}])
        if request.method == "GET" and path.rstrip("/").endswith("/User"):
            return httpx.Response(
                200,
                json=[
                    {"id": 3, "name": "ivan", "realname": "Иванов", "firstname": "Иван"},
                    {"id": 4, "name": "petr", "realname": "Петров", "firstname": "Пётр"},
                ],
            )
        if request.method == "POST" and path.endswith("/Ticket") and "Ticket_User" not in path:
            body = json.loads(request.content.decode())
            posts.append(body)
            return httpx.Response(201, json={"id": 501})
        if request.method == "PUT" and "/Ticket/501" in path and "Ticket_User" not in path:
            return httpx.Response(200, json={"id": 501})
        if request.method == "GET" and "Ticket_User" in path:
            return httpx.Response(200, json=[])
        if request.method == "POST" and path.endswith("/Ticket_User"):
            posts.append(json.loads(request.content.decode()))
            return httpx.Response(201, json={"id": 1})
        return httpx.Response(404, json=["ERROR", path])

    results = push_tickets(
        _legacy_creds(),
        [
            GlpiOutbound(
                corax_id=20,
                glpi_id=None,
                title="Закрытый инцидент",
                content="решено",
                status="done",
                priority="normal",
                requester="Иван Иванов",
                assignee="Пётр Петров",
                category="Сеть",
            )
        ],
        transport=httpx.MockTransport(handler),
    )
    assert results[0].action == "created"
    assert results[0].glpi_id == 501
    ticket_input = next(
        p.get("input", p) for p in posts if isinstance(p.get("input", p), dict) and p.get("input", p).get("name") == "Закрытый инцидент"
    )
    assert ticket_input["status"] == 5
    assert ticket_input.get("itilcategories_id") == 9
    assert ticket_input.get("_users_id_requester") == 3
    assert ticket_input.get("_users_id_assign") == 4


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


def test_import_does_not_blank_filled_computer_fields():
    from app.glpi_assets import _apply_fields
    from app.models import Computer

    row = Computer(hostname="pc-a", manufacturer="Dell", serial_number="KEEP", os_name="Windows 10")
    asset = GlpiComputer(glpi_id=1, name="PC-A", serial=None, manufacturer=None, os_name="Windows 11", software=None)
    assert _apply_fields(row, asset) is True
    assert row.hostname == "PC-A"
    assert row.manufacturer == "Dell"
    assert row.serial_number == "KEEP"
    assert row.os_name == "Windows 11"


def test_software_identity_matches_case_and_blank_version():
    assert software_key("Google Chrome", "120") == software_key("google chrome", "120")
    assert canonical_software("  A   B  ", " 1 ") == ("A B", "1")
    assert canonical_software("Chrome", "-") == ("Chrome", None)
    assert same_software_set(
        [("Google Chrome", "120"), ("OldApp", "1.0")],
        [("google chrome", "120"), ("OldApp", "1.0")],
    )
    assert not same_software_set([("Google Chrome", "120")], [("Google Chrome", "121")])


def test_parse_computer_reads_expanded_dropdowns_and_nested_software():
    computer = parse_computer(
        {
            "id": 7,
            "name": "pc-lab-01",
            "serial": "SN1",
            "manufacturers_id": "Dell",
            "computermodels_id": {"id": 3, "name": "OptiPlex"},
            "locations_id": "Каб. 1",
            "comment": "стойка",
            "_softwares": [
                {
                    "id": 15,
                    "softwareversions_id": {"id": 9, "name": "120", "softwares_id": {"id": 4, "name": "Google Chrome"}},
                }
            ],
        }
    )
    assert computer is not None
    assert computer.manufacturer == "Dell"
    assert computer.model == "OptiPlex"
    assert computer.location == "Каб. 1"
    assert computer.software is not None
    assert [(item.name, item.version) for item in computer.software] == [("Google Chrome", "120")]


def test_v2_fetch_computers_resolves_software_os_and_unknown_software():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/api.php/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        if path.endswith("/Assets/Computer") and request.method == "GET":
            assert request.headers["authorization"] == "Bearer atk"
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 7,
                        "name": "pc-a",
                        "serial": "SN1",
                        "manufacturer": {"id": 1, "name": "Dell"},
                        "model": {"id": 2, "name": "OptiPlex"},
                        "location": {"id": 3, "name": "Каб. 1"},
                        "comment": "стойка",
                    },
                    {"id": 8, "name": "pc-b", "serial": "SN2"},
                ],
            )
        if path.endswith("/Computer/7/Item_SoftwareVersion"):
            assert request.headers["authorization"] == "Bearer atk"
            return httpx.Response(200, json=[{"id": 15, "items_id": 7, "itemtype": "Computer", "softwareversions_id": 9}])
        if path.endswith("/Computer/8/Item_SoftwareVersion"):
            return httpx.Response(404, json={"message": "ERROR_ITEM_NOT_FOUND"})
        if path.endswith("/SoftwareVersion/9"):
            return httpx.Response(200, json={"id": 9, "name": "120.0", "softwares_id": 4})
        if path.endswith("/Software/4"):
            return httpx.Response(200, json={"id": 4, "name": "Google Chrome"})
        if path.endswith("/Computer/7/Item_OperatingSystem"):
            return httpx.Response(
                200,
                json=[{"id": 3, "operatingsystems_id": "Windows 11", "operatingsystemversions_id": "23H2"}],
            )
        if path.endswith("/Computer/8/Item_OperatingSystem"):
            return httpx.Response(404, json={"message": "missing"})
        return httpx.Response(404, json={"message": f"{request.method} {path}"})

    computers = fetch_computers(_v2_creds(), 10, transport=httpx.MockTransport(handler))
    assert [item.name for item in computers] == ["pc-a", "pc-b"]
    first = computers[0]
    assert first.manufacturer == "Dell"
    assert first.model == "OptiPlex"
    assert first.location == "Каб. 1"
    assert first.os_name == "Windows 11"
    assert first.os_version == "23H2"
    assert first.software is not None
    assert [(item.name, item.version, item.link_id) for item in first.software] == [("Google Chrome", "120.0", 15)]
    assert computers[1].software is None
    assert computers[1].os_name is None


def test_v2_push_replaces_software_set_and_updates_computer():
    deleted: list[str] = []
    created_install: list[dict] = []
    patched: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/api.php/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        if path.endswith("/Assets/Computer") and request.method == "GET":
            assert request.url.params.get("filter") == "name==PC-01"
            return httpx.Response(200, json=[{"id": 7, "name": "PC-01", "serial": "OLD"}])
        if path.endswith("/Manufacturer"):
            return httpx.Response(200, json=[{"id": 5, "name": "Dell"}])
        if path.endswith("/Assets/Computer/7") and request.method == "PATCH":
            patched.append(json.loads(request.content.decode()))
            return httpx.Response(200, json={"id": 7})
        if path.endswith("/Computer/7/Item_SoftwareVersion"):
            return httpx.Response(200, json=[{"id": 3, "items_id": 7, "itemtype": "Computer", "softwareversions_id": 9}])
        if path.endswith("/SoftwareVersion/9"):
            return httpx.Response(200, json={"id": 9, "name": "1.0", "softwares_id": 4})
        if path.endswith("/Software/4"):
            return httpx.Response(200, json={"id": 4, "name": "OldApp"})
        if path.endswith("/Item_SoftwareVersion/3") and request.method == "DELETE":
            deleted.append(path)
            return httpx.Response(200, json={})
        if path.endswith("/Software") and request.method == "GET":
            return httpx.Response(200, json=[{"id": 8, "name": "Google Chrome"}])
        if path.endswith("/SoftwareVersion") and request.method == "GET":
            return httpx.Response(200, json=[{"id": 11, "name": "120", "softwares_id": 8}])
        if path.endswith("/Item_SoftwareVersion") and request.method == "POST":
            created_install.append(json.loads(request.content.decode()))
            return httpx.Response(201, json={"id": 40})
        if path.endswith("/Computer/7/Item_OperatingSystem") and request.method == "GET":
            return httpx.Response(200, json=[])
        if path.endswith("/OperatingSystem") and request.method == "GET":
            return httpx.Response(200, json=[{"id": 2, "name": "Windows 11"}])
        if path.endswith("/OperatingSystemVersion") and request.method == "GET":
            return httpx.Response(200, json=[{"id": 6, "name": "23H2", "operatingsystems_id": 2}])
        if path.endswith("/Item_OperatingSystem") and request.method == "POST":
            return httpx.Response(201, json={"id": 12})
        return httpx.Response(404, json={"message": f"{request.method} {path}"})

    results = push_computers(
        _v2_creds(),
        [
            GlpiComputerOutbound(
                corax_id=4,
                hostname="PC-01",
                serial="SN1",
                manufacturer="Dell",
                os_name="Windows 11",
                os_version="23H2",
                software=(("Google Chrome", "120"),),
            )
        ],
        transport=httpx.MockTransport(handler),
    )
    assert results[0].action == "updated", results[0].error
    assert results[0].glpi_id == 7
    assert patched[0]["name"] == "PC-01"
    assert patched[0]["serial"] == "SN1"
    assert patched[0]["manufacturer"] == {"id": 5}
    assert deleted == ["/glpi/apirest.php/Item_SoftwareVersion/3"]
    assert created_install[0]["input"] == {
        "itemtype": "Computer",
        "items_id": 7,
        "softwareversions_id": 11,
    }


def test_v2_push_creates_computer_when_hostname_is_unknown():
    created: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/api.php/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        if path.endswith("/Assets/Computer") and request.method == "GET":
            return httpx.Response(200, json=[])
        if path.endswith("/Assets/Computer") and request.method == "POST":
            created.append(json.loads(request.content.decode()))
            return httpx.Response(201, json={"id": 20})
        if path.endswith("/Computer/20/Item_SoftwareVersion"):
            return httpx.Response(200, json=[])
        return httpx.Response(404, json={"message": f"{request.method} {path}"})

    results = push_computers(
        _v2_creds(),
        [GlpiComputerOutbound(corax_id=1, hostname="new-pc", software=())],
        transport=httpx.MockTransport(handler),
    )
    assert results[0].action == "created", results[0].error
    assert results[0].glpi_id == 20
    assert created[0]["name"] == "new-pc"
    assert "manufacturer" not in created[0]


def test_push_computer_includes_ip_in_comment():
    from app.glpi_client import _comment_with_ip

    assert _comment_with_ip(None, "10.1.2.3") == "IP: 10.1.2.3"
    assert _comment_with_ip("note", "10.1.2.3") == "note\nIP: 10.1.2.3"
    assert _comment_with_ip("note\nIP: 10.1.2.3", "10.1.2.3") == "note\nIP: 10.1.2.3"
    assert _comment_with_ip("note", None) == "note"
    assert _comment_with_ip(None, None) is None

    created: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/api.php/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        if path.endswith("/Assets/Computer") and request.method == "GET":
            return httpx.Response(200, json=[])
        if path.endswith("/Assets/Computer") and request.method == "POST":
            created.append(json.loads(request.content.decode()))
            return httpx.Response(201, json={"id": 33})
        if "NetworkPort" in path:
            return httpx.Response(200, json=[])
        if path.endswith("/Computer/33/Item_SoftwareVersion"):
            return httpx.Response(200, json=[])
        return httpx.Response(404, json={"message": f"{request.method} {path}"})

    results = push_computers(
        _v2_creds(),
        [
            GlpiComputerOutbound(
                corax_id=2,
                hostname="pc-ip",
                ip_address="192.168.10.5",
                comment="кабинет",
                software=(),
            )
        ],
        transport=httpx.MockTransport(handler),
    )
    assert results[0].action == "created", results[0].error
    assert "IP: 192.168.10.5" in created[0]["comment"]
    assert created[0]["comment"].startswith("кабинет")


def test_push_computer_other_entity_update_blocked_no_duplicate():
    """ПК в другом подразделении: UPDATE падает — дубликат не создаём."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/api.php/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        if path.endswith("/Assets/Computer") and request.method == "GET":
            return httpx.Response(
                200,
                json=[{"id": 3199, "name": "PC-OTHER", "entities_id": 7, "serial": "SN-X"}],
            )
        if "/Assets/Computer/3199" in path and request.method == "PATCH":
            return httpx.Response(400, json=["ERROR_API", "You don't have permission"])
        if path.endswith("/Assets/Computer") and request.method == "POST":
            return httpx.Response(500, json={"message": "should not create duplicate"})
        return httpx.Response(404, json={"message": f"{request.method} {path}"})

    results = push_computers(
        _v2_creds(),
        [GlpiComputerOutbound(corax_id=5, hostname="PC-OTHER", serial="SN-X", software=())],
        transport=httpx.MockTransport(handler),
    )
    assert results[0].action == "failed"
    assert results[0].glpi_id is None
    assert "3199" in (results[0].error or "")
    assert "Дубликат не создан" in (results[0].error or "")


def test_friendly_error_api_mentions_entity():
    from app.glpi_client import _friendly

    text = _friendly("ERROR_API something")
    assert "сущност" in text.casefold() or "подраздел" in text.casefold()


def test_glpi_asset_import_and_export_keep_the_same_software_set(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    host = unique_hostname("glpi-pc")

    def fake_fetch(creds, limit, transport=None):
        return [
            GlpiComputer(
                glpi_id=77,
                name=host,
                serial="SN-GLPI-1",
                manufacturer="Dell",
                model="OptiPlex",
                location="Каб. 2",
                os_name="Windows 11",
                os_version="23H2",
                comment="из GLPI",
                software=(
                    GlpiSoftware(name="Google Chrome", version="120"),
                    GlpiSoftware(name="7-Zip", version=None),
                ),
            )
        ]

    monkeypatch.setattr("app.glpi_assets.fetch_computers", fake_fetch)
    saved = client.put(
        "/api/v1/settings/glpi",
        headers=auth_headers,
        json={"enabled": True, "base_url": "http://glpi.local/glpi", "api_mode": "v2"},
    )
    assert saved.status_code == 200, saved.text

    imported = client.post("/api/v1/settings/glpi/import-assets", headers=auth_headers, json={"limit": 10})
    assert imported.status_code == 200, imported.text
    assert imported.json()["created"] == 1

    listed = client.get("/api/v1/computers", headers=auth_headers, params={"q": host, "limit": 10})
    assert listed.status_code == 200, listed.text
    match = next(item for item in listed.json()["items"] if item["hostname"] == host)
    assert match["manufacturer"] == "Dell"
    assert match["model"] == "OptiPlex"
    assert match["serial_number"] == "SN-GLPI-1"
    assert match["os_name"] == "Windows 11"
    pc_id = match["id"]
    software = client.get(f"/api/v1/computers/{pc_id}/software", headers=auth_headers)
    assert software.status_code == 200, software.text
    assert same_software_set(
        [(row["name"], row["version"]) for row in software.json()],
        [("Google Chrome", "120"), ("7-Zip", None)],
    )

    def fetch_same_software(creds, limit, transport=None):
        rows = fake_fetch(creds, limit, transport)
        return [replace(rows[0], manufacturer="Lenovo", software=None)]

    monkeypatch.setattr("app.glpi_assets.fetch_computers", fetch_same_software)
    updated = client.post("/api/v1/settings/glpi/import-assets", headers=auth_headers, json={"limit": 10})
    assert updated.status_code == 200, updated.text
    assert updated.json()["updated"] == 1
    software_after = client.get(f"/api/v1/computers/{pc_id}/software", headers=auth_headers)
    assert same_software_set(
        [(row["name"], row["version"]) for row in software_after.json()],
        [("Google Chrome", "120"), ("7-Zip", None)],
    )
    detail = client.get(f"/api/v1/computers/{pc_id}", headers=auth_headers)
    assert detail.json()["manufacturer"] == "Lenovo"

    pushed: list[GlpiComputerOutbound] = []

    def fake_push(creds, items, transport=None):
        pushed.extend(items)
        return [
            GlpiAssetPushResult(corax_id=item.corax_id, glpi_id=77, action="updated")
            for item in items
        ]

    monkeypatch.setattr("app.glpi_assets.push_computers", fake_push)
    exported = client.post("/api/v1/settings/glpi/export-assets", headers=auth_headers, json={"limit": 2000})
    assert exported.status_code == 200, exported.text
    outbound = next(item for item in pushed if item.hostname == host)
    assert outbound.manufacturer == "Lenovo"
    assert outbound.serial == "SN-GLPI-1"
    assert outbound.os_version == "23H2"
    assert same_software_set(outbound.software, [("Google Chrome", "120"), ("7-Zip", None)])
    client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)
