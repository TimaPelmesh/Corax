from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient


def test_printers_list_and_poll_config(client: TestClient, auth_headers: dict[str, str]):
    listed = client.get("/api/v1/printers", headers=auth_headers)
    assert listed.status_code == 200
    assert isinstance(listed.json(), list)

    cfg = client.get("/api/v1/printers/poll-config", headers=auth_headers)
    assert cfg.status_code == 200
    assert "poll_enabled" in cfg.json()

    sched = client.get("/api/v1/printers/scheduler-status", headers=auth_headers)
    assert sched.status_code == 200


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
