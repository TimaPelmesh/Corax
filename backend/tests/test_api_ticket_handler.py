from helpers import sample_inventory, unique_hostname
from starlette.testclient import TestClient


def test_ticket_handler_public_context_and_intake(client: TestClient, agent_headers: dict[str, str]):
    hostname = unique_hostname("handler")
    posted = client.post("/api/v1/agent/inventory", json=sample_inventory(hostname), headers=agent_headers)
    assert posted.status_code == 200, posted.text

    context = client.get("/api/v1/ticket-handler/public/context", params={"hostname": hostname})
    assert context.status_code == 200, context.text
    body = context.json()
    assert body["enabled"] is True
    assert hostname.lower() in str(body.get("hostname") or "").lower()

    tickets = client.get("/api/v1/ticket-handler/public/tickets", params={"hostname": hostname})
    assert tickets.status_code == 200, tickets.text
    assert isinstance(tickets.json().get("items"), list)

    created = client.post(
        "/api/v1/ticket-handler/intake",
        json={"hostname": hostname, "title": "Не печатает принтер на 3 этаже"},
    )
    assert created.status_code == 200, created.text
    out = created.json()
    assert out["ok"] is True
    assert out["request_id"]

    after = client.get("/api/v1/ticket-handler/public/tickets", params={"hostname": hostname})
    assert after.status_code == 200, after.text
    created_row = next(row for row in after.json()["items"] if row["id"] == out["request_id"])
    assert created_row["status"] == "open"
    assert created_row["assignees"] == []

    directory = client.get("/api/v1/ticket-handler/public/directory", params={"hostname": hostname})
    assert directory.status_code == 200, directory.text
    assert isinstance(directory.json().get("items"), list)

    tabs = client.get("/api/v1/ticket-handler/public/tabs", params={"hostname": hostname})
    assert tabs.status_code == 200, tabs.text
    assert tabs.json().get("items") == []

    login = client.post(
        "/api/v1/auth/login/json",
        json={"username": "admin", "password": "admin123", "return_token": True},
    )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    saved = client.put(
        "/api/v1/ticket-handler/config",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "employee_tabs": [
                {
                    "title": "Телефоны",
                    "kind": "table",
                    "columns": ["Кто", "Номер"],
                    "rows": [["IT", "100"]],
                    "enabled": True,
                },
                {"title": "Черновик", "kind": "text", "body": "скрыто", "enabled": False},
            ]
        },
    )
    assert saved.status_code == 200, saved.text
    stored = saved.json().get("employee_tabs") or []
    assert [row["title"] for row in stored] == ["Телефоны", "Черновик"]

    public = client.get("/api/v1/ticket-handler/public/tabs", params={"hostname": hostname})
    assert public.status_code == 200, public.text
    visible = public.json().get("items") or []
    assert [row["title"] for row in visible] == ["Телефоны"]
    assert visible[0]["rows"] == [["IT", "100"]]


def test_ticket_handler_lan_without_hostname_is_rejected(client: TestClient):
    response = client.post(
        "/api/v1/ticket-handler/intake",
        json={"title": "Заявка без известного компьютера"},
    )
    assert response.status_code == 403, response.text
    response = client.post("/api/v1/ticket-handler/intake", json={"title": "ab"})
    assert response.status_code == 422
