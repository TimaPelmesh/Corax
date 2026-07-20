from __future__ import annotations

from helpers import sample_inventory, unique_hostname
from starlette.testclient import TestClient


def _create_pc(client: TestClient, agent_headers: dict[str, str], auth_headers: dict[str, str]) -> int:
    hn = unique_hostname()
    r = client.post("/api/v1/agent/inventory", json=sample_inventory(hn), headers=agent_headers)
    assert r.status_code == 200, r.text
    return int(r.json()["computer_id"])


def test_computers_list_and_export_csv(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/computers", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert "items" in body
    assert "total" in body
    assert isinstance(body["items"], list)

    csv = client.get("/api/v1/computers/export.csv", headers=auth_headers)
    assert csv.status_code == 200
    assert "text/csv" in csv.headers.get("content-type", "")


def test_computer_detail_patch_tags_delete(
    client: TestClient,
    agent_headers: dict[str, str],
    auth_headers: dict[str, str],
):
    pc_id = _create_pc(client, agent_headers, auth_headers)

    tag = client.post(
        "/api/v1/tags",
        headers=auth_headers,
        json={"name": unique_hostname("tag"), "color": "#336699"},
    )
    assert tag.status_code == 200
    tag_id = tag.json()["id"]

    patched = client.patch(
        f"/api/v1/computers/{pc_id}",
        headers=auth_headers,
        json={"notes": "pytest note", "location": "Lab 2", "tag_ids": [tag_id]},
    )
    assert patched.status_code == 200
    assert patched.json()["notes"] == "pytest note"
    assert patched.json()["location"] == "Lab 2"
    assert any(t["id"] == tag_id for t in patched.json()["tags"])

    detail = client.get(f"/api/v1/computers/{pc_id}", headers=auth_headers)
    assert detail.status_code == 200
    assert len(detail.json()["software"]) >= 2

    light = client.get(
        f"/api/v1/computers/{pc_id}?include_software=false",
        headers=auth_headers,
    )
    assert light.status_code == 200
    assert light.json()["software"] == []
    assert light.json()["software_count"] >= 2

    sw = client.get(f"/api/v1/computers/{pc_id}/software", headers=auth_headers)
    assert sw.status_code == 200
    assert len(sw.json()) >= 2

    history = client.get(f"/api/v1/computers/{pc_id}/history", headers=auth_headers)
    assert history.status_code == 200

    deleted = client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)
    assert deleted.status_code == 204

    client.delete(f"/api/v1/tags/{tag_id}", headers=auth_headers)


def test_computer_not_found(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/computers/999999999", headers=auth_headers)
    assert r.status_code == 404


def test_computers_list_views_and_pagination(
    client: TestClient,
    agent_headers: dict[str, str],
    auth_headers: dict[str, str],
):
    pc_id = _create_pc(client, agent_headers, auth_headers)

    listed = client.get("/api/v1/computers?view=list&limit=50", headers=auth_headers)
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert "items" in body and "total" in body
    assert body["total"] >= 1
    hit = next((x for x in body["items"] if x["id"] == pc_id), None)
    assert hit is not None
    assert "hostname" in hit
    assert "software_count" in hit
    assert "raw_payload" not in hit
    assert hit.get("disks") == []

    mapped = client.get("/api/v1/computers?view=map&limit=50", headers=auth_headers)
    assert mapped.status_code == 200, mapped.text
    mbody = mapped.json()
    mhit = next((x for x in mbody["items"] if x["id"] == pc_id), None)
    assert mhit is not None
    assert set(mhit.keys()) <= {
        "id",
        "hostname",
        "serial_number",
        "model",
        "os_name",
        "ram_gb",
        "ip_address",
        "ping_status",
        "last_ping_at",
    }
    assert "software_count" not in mhit
    assert "tags" not in mhit

    page = client.get(
        "/api/v1/computers?view=list&skip=0&limit=1&sort=host&sort_dir=asc",
        headers=auth_headers,
    )
    assert page.status_code == 200
    assert len(page.json()["items"]) <= 1
    assert page.json()["total"] >= 1

    client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)
