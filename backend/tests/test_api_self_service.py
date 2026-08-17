from starlette.testclient import TestClient

from helpers import sample_inventory, unique_hostname


def test_self_service_creates_request_for_reported_computer(
    client: TestClient, agent_headers: dict[str, str], auth_headers: dict[str, str]
):
    hostname = unique_hostname("self-service")
    assert client.post("/api/v1/agent/inventory", json=sample_inventory(hostname), headers=agent_headers).status_code == 200
    context = client.get("/api/v1/self-service/context", params={"hostname": hostname})
    assert context.status_code == 200, context.text
    created = client.post(
        "/api/v1/self-service/requests",
        json={
            "hostname": hostname,
            "requester_name": "Тестовый пользователь",
            "title": "Плановая установка ПО",
            "category": "software",
        },
    )
    assert created.status_code == 200, created.text
    request_id = created.json()["request_id"]
    listed = client.get("/api/v1/service-requests", headers=auth_headers, params={"limit": 1000})
    assert any(row["id"] == request_id and row["computer_hostname"] == hostname for row in listed.json()["items"])


def test_self_service_rejects_unknown_computer(client: TestClient):
    response = client.get("/api/v1/self-service/context", params={"hostname": "missing-pc"})
    assert response.status_code == 404
