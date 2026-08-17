from __future__ import annotations

from starlette.testclient import TestClient


def test_network_list_and_poll_config(client: TestClient, auth_headers: dict[str, str]):
    listed = client.get("/api/v1/network/devices", headers=auth_headers)
    assert listed.status_code == 200
    assert isinstance(listed.json(), list)

    cfg = client.get("/api/v1/network/poll-config", headers=auth_headers)
    assert cfg.status_code == 200
    body = cfg.json()
    assert "snmp_community" in body
    assert "poll_concurrency" in body
    assert "cidr_list" in body
    assert isinstance(body["cidr_list"], list)

    topo = client.get("/api/v1/network/topology", headers=auth_headers)
    assert topo.status_code == 200
    t = topo.json()
    assert "nodes" in t and "edges" in t
    assert isinstance(t["nodes"], list)
    assert isinstance(t["edges"], list)


def test_network_poll_config_update(client: TestClient, auth_headers: dict[str, str]):
    updated = client.put(
        "/api/v1/network/poll-config",
        headers=auth_headers,
        json={
            "poll_enabled": False,
            "poll_interval_minutes": 90,
            "snmp_community": "public",
            "snmp_timeout_seconds": 2.5,
            "poll_concurrency": 6,
            "cidr_list": ["192.168.10.0/24", "10.1.0.0/24"],
        },
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["poll_interval_minutes"] == 90
    assert body["poll_concurrency"] == 6
    assert float(body["snmp_timeout_seconds"]) == 2.5
    assert body["cidr_list"] == ["192.168.10.0/24", "10.1.0.0/24"]


def test_network_device_manual_crud(client: TestClient, auth_headers: dict[str, str]):
    created = client.post(
        "/api/v1/network/devices",
        headers=auth_headers,
        json={
            "ip_address": "192.168.99.10",
            "hostname": "pytest-sw-01",
            "device_type": "switch",
        },
    )
    assert created.status_code == 200, created.text
    device_id = created.json()["id"]
    assert created.json()["ip_address"] == "192.168.99.10"

    patched = client.patch(
        f"/api/v1/network/devices/{device_id}",
        headers=auth_headers,
        json={"location": "Rack A", "device_type": "switch"},
    )
    assert patched.status_code == 200
    assert patched.json()["location"] == "Rack A"

    detail = client.get(f"/api/v1/network/devices/{device_id}", headers=auth_headers)
    assert detail.status_code == 200
    assert detail.json()["hostname"] == "pytest-sw-01"

    topo = client.get("/api/v1/network/topology", headers=auth_headers)
    assert topo.status_code == 200
    node_ids = {n["id"] for n in topo.json()["nodes"]}
    assert f"network_device:{device_id}" in node_ids

    deleted = client.delete(f"/api/v1/network/devices/{device_id}", headers=auth_headers)
    assert deleted.status_code == 204
