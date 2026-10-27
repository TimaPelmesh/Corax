from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient


def test_printers_list_and_poll_config(client: TestClient, auth_headers: dict[str, str]):
    listed = client.get("/api/v1/printers", headers=auth_headers)
    assert listed.status_code == 200
    assert isinstance(listed.json(), list)

    cfg = client.get("/api/v1/printers/poll-config", headers=auth_headers)
    assert cfg.status_code == 200
    body = cfg.json()
    assert "poll_enabled" in body
    assert "poll_concurrency" in body
    assert "snmp_timeout_seconds" in body

    sched = client.get("/api/v1/printers/scheduler-status", headers=auth_headers)
    assert sched.status_code == 200


def test_printers_map_view(client: TestClient, auth_headers: dict[str, str]):
    created = client.post(
        "/api/v1/printers",
        headers=auth_headers,
        json={"name": f"MapPrinter {unique_hostname('prn')}", "ip_address": "10.55.55.55"},
    )
    assert created.status_code == 200, created.text
    pid = created.json()["id"]

    mapped = client.get("/api/v1/printers?view=map&limit=100", headers=auth_headers)
    assert mapped.status_code == 200, mapped.text
    rows = mapped.json()
    assert isinstance(rows, list)
    hit = next((r for r in rows if r["id"] == pid), None)
    assert hit is not None
    assert "toner_min_percent" in hit
    assert "supplies" not in hit
    assert "driver_name" not in hit

    client.delete(f"/api/v1/printers/{pid}", headers=auth_headers)


def test_printer_poll_config_update(client: TestClient, auth_headers: dict[str, str]):
    updated = client.put(
        "/api/v1/printers/poll-config",
        headers=auth_headers,
        json={
            "poll_enabled": True,
            "poll_interval_minutes": 15,
            "snmp_enabled": True,
            "snmp_community": "public",
            "snmp_timeout_seconds": 3.5,
            "ping_timeout_ms": 900,
            "poll_concurrency": 10,
        },
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["poll_interval_minutes"] == 15
    assert body["poll_concurrency"] == 10
    assert float(body["snmp_timeout_seconds"]) == 3.5


def test_printer_manual_crud(client: TestClient, auth_headers: dict[str, str]):
    created = client.post(
        "/api/v1/printers",
        headers=auth_headers,
        json={
            "name": f"Pytest Printer {unique_hostname('prn')}",
            "ip_address": "192.168.99.50",
        },
    )
    assert created.status_code == 200, created.text
    printer_id = created.json()["id"]

    patched = client.patch(
        f"/api/v1/printers/{printer_id}",
        headers=auth_headers,
        json={"location": "Кабинет 5"},
    )
    assert patched.status_code == 200
    assert patched.json()["location"] == "Кабинет 5"

    deleted = client.delete(f"/api/v1/printers/{printer_id}", headers=auth_headers)
    assert deleted.status_code == 204
