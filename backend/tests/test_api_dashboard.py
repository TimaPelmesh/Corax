from __future__ import annotations

from helpers import sample_inventory, unique_hostname
from starlette.testclient import TestClient


def test_dashboard_summary(client: TestClient, auth_headers: dict[str, str], agent_headers: dict[str, str]):
    hn = unique_hostname("dash")
    client.post("/api/v1/agent/inventory", json=sample_inventory(hn), headers=agent_headers)

    r = client.get("/api/v1/dashboard/summary", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    for key in (
        "computers_total",
        "computers_online",
        "computers_offline",
        "service_requests_on_time_pct",
        "by_os",
        "ram_buckets",
        "by_manufacturer",
        "physical_disks_by_media",
        "peripheral_kinds",
    ):
        assert key in body
    assert isinstance(body["computers_online"], int)
    assert isinstance(body["computers_offline"], int)
    assert body["service_requests_on_time_pct"] is None or isinstance(body["service_requests_on_time_pct"], int)

    catalog = client.get(
        "/api/v1/dashboard/software-catalog",
        headers=auth_headers,
        params={"q": "Chrome", "limit": 5},
    )
    assert catalog.status_code == 200

    if catalog.json():
        name = catalog.json()[0]["name"]
        hosts = client.get(
            "/api/v1/dashboard/software-hosts",
            headers=auth_headers,
            params={"name": name},
        )
        assert hosts.status_code == 200
        assert "hostnames" in hosts.json()

    seg = client.get(
        "/api/v1/dashboard/segment-computers",
        headers=auth_headers,
        params={"kind": "os", "name": "Windows 10 Pro"},
    )
    assert seg.status_code == 200
    assert "items" in seg.json()

    pcs = client.get("/api/v1/computers", headers=auth_headers, params={"q": hn})
    pc_id = pcs.json()["items"][0]["id"]
    client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)
