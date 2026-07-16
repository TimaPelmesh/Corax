from __future__ import annotations

from helpers import sample_inventory, unique_hostname
from starlette.testclient import TestClient


def _create_pc(client: TestClient, agent_headers: dict[str, str]) -> int:
    hn = unique_hostname()
    r = client.post("/api/v1/agent/inventory", json=sample_inventory(hn), headers=agent_headers)
    assert r.status_code == 200, r.text
    return int(r.json()["computer_id"])


def test_computer_detail_light_and_software_endpoint(
    client: TestClient,
    auth_headers: dict[str, str],
    agent_headers: dict[str, str],
):
    """Modal optimization: core detail without software list + separate /software."""
    pc_id = _create_pc(client, agent_headers)
    try:
        full = client.get(f"/api/v1/computers/{pc_id}", headers=auth_headers)
        assert full.status_code == 200, full.text
        full_body = full.json()
        assert len(full_body["software"]) >= 2
        assert full_body["software_count"] >= 2

        light = client.get(
            f"/api/v1/computers/{pc_id}?include_software=false",
            headers=auth_headers,
        )
        assert light.status_code == 200, light.text
        light_body = light.json()
        assert light_body["software"] == []
        assert light_body["software_count"] == full_body["software_count"]
        assert light_body["hostname"] == full_body["hostname"]
        assert light_body["cpu"] == full_body["cpu"]
        assert isinstance(light_body.get("peripherals"), list)

        sw = client.get(f"/api/v1/computers/{pc_id}/software", headers=auth_headers)
        assert sw.status_code == 200, sw.text
        names = {row["name"] for row in sw.json()}
        assert "Microsoft Office" in names
        assert "Google Chrome" in names
        assert len(sw.json()) == full_body["software_count"]
    finally:
        client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)


def test_computer_software_not_found(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/computers/999999999/software", headers=auth_headers)
    assert r.status_code == 404


def test_computer_software_requires_auth(client: TestClient):
    assert client.get("/api/v1/computers/1/software").status_code == 401
