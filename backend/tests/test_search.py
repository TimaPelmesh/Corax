from starlette.testclient import TestClient

from helpers import sample_inventory, unique_hostname


def test_catalog_search_indexes_agent_inventory(
    client: TestClient, agent_headers: dict[str, str], auth_headers: dict[str, str]
):
    hostname = unique_hostname("search-pc")
    report = sample_inventory(hostname)
    report["serial_number"] = f"SERIAL-{hostname}"
    report["software"] = [{"name": "Контур Экстерн", "version": "3.2"}]

    created = client.post("/api/v1/agent/inventory", json=report, headers=agent_headers)
    assert created.status_code == 200, created.text
    computer_id = created.json()["computer_id"]

    exact = client.get("/api/v1/search", params={"q": hostname}, headers=auth_headers)
    assert exact.status_code == 200, exact.text
    items = exact.json()["items"]
    assert any(x["entity_type"] == "computer" and x["entity_id"] == computer_id for x in items)

    software = client.get(
        "/api/v1/search",
        params=[("q", "Контур Экстерн"), ("types", "software")],
        headers=auth_headers,
    )
    assert software.status_code == 200, software.text
    assert any(x["entity_type"] == "software" for x in software.json()["items"])

    deleted = client.delete(f"/api/v1/computers/{computer_id}", headers=auth_headers)
    assert deleted.status_code == 204


def test_catalog_search_indexes_service_requests_and_rebuild(
    client: TestClient, auth_headers: dict[str, str]
):
    title = f"Не печатает принтер {unique_hostname('search-ticket')}"
    created = client.post(
        "/api/v1/service-requests",
        headers=auth_headers,
        json={"title": title, "description": "В кабинете 101 закончился тонер", "status": "open"},
    )
    assert created.status_code == 200, created.text
    request_id = created.json()["id"]

    found = client.get("/api/v1/search", params={"q": "не печатает принтер"}, headers=auth_headers)
    assert found.status_code == 200, found.text
    assert any(
        x["entity_type"] == "service_request" and x["entity_id"] == request_id
        for x in found.json()["items"]
    )

    rebuilt = client.post("/api/v1/search/reindex", headers=auth_headers)
    assert rebuilt.status_code == 200, rebuilt.text
    assert rebuilt.json()["indexed"]["service_requests"] >= 1

    client.post(f"/api/v1/service-requests/{request_id}/delete", headers=auth_headers)
