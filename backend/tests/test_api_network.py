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
    assert any(n.get("id") == "corax:self" and n.get("kind") == "corax" for n in t["nodes"])


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


def test_network_map_scene_and_manual_links(client: TestClient, auth_headers: dict[str, str]):
    a = client.post(
        "/api/v1/network/devices",
        headers=auth_headers,
        json={"ip_address": "192.168.77.21", "hostname": "pytest-map-sw", "device_type": "switch"},
    )
    b = client.post(
        "/api/v1/network/devices",
        headers=auth_headers,
        json={"ip_address": "192.168.77.22", "hostname": "pytest-map-fw", "device_type": "firewall"},
    )
    assert a.status_code == 200, a.text
    assert b.status_code == 200, b.text
    id_a = a.json()["id"]
    id_b = b.json()["id"]
    try:
        empty = client.get("/api/v1/network/map-scene", headers=auth_headers)
        assert empty.status_code == 200, empty.text
        body = empty.json()
        assert body["scene"]["version"] == 1
        assert body["scene"]["nodes"] == []

        saved = client.put(
            "/api/v1/network/map-scene",
            headers=auth_headers,
            json={
                "title": "LAN HQ",
                "scene": {
                    "version": 1,
                    "groups": [
                        {
                            "id": "room-1",
                            "title": "Серверная",
                            "kind": "room",
                            "x": 0,
                            "y": 0,
                            "width": 480,
                            "height": 320,
                        }
                    ],
                    "nodes": [
                        {
                            "id": f"network_device:{id_a}",
                            "stencil": "switch",
                            "x": 40,
                            "y": 60,
                            "parentGroupId": "room-1",
                            "bind": {"type": "network_device", "id": id_a},
                        }
                    ],
                    "edges": [],
                    "hiddenNodeIds": [f"network_device:{id_b}"],
                    "viewport": {"x": 0, "y": 0, "zoom": 0.8},
                },
            },
        )
        assert saved.status_code == 200, saved.text
        scene = saved.json()["scene"]
        assert saved.json()["title"] == "LAN HQ"
        assert scene["nodes"][0]["bind"]["id"] == id_a
        assert scene["hiddenNodeIds"] == [f"network_device:{id_b}"]

        linked = client.post(
            "/api/v1/network/links",
            headers=auth_headers,
            json={
                "from_type": "network_device",
                "from_id": id_a,
                "to_type": "network_device",
                "to_id": id_b,
                "local_port": "Gi1/0/1",
            },
        )
        assert linked.status_code == 200, linked.text
        link_id = linked.json()["id"]
        assert linked.json()["link_type"] == "manual"

        topo = client.get("/api/v1/network/topology", headers=auth_headers)
        assert topo.status_code == 200
        edges = topo.json()["edges"]
        assert any(
            e["link_type"] == "manual"
            and {e["source"], e["target"]} == {f"network_device:{id_a}", f"network_device:{id_b}"}
            for e in edges
        )

        deleted_link = client.delete(f"/api/v1/network/links/{link_id}", headers=auth_headers)
        assert deleted_link.status_code == 204

        live = client.post(
            "/api/v1/network/map-live",
            headers=auth_headers,
            json={
                "binds": [
                    {"type": "network_device", "id": id_a},
                    {"type": "network_device", "id": 9_999_999},
                    {"type": "corax", "id": 0},
                ]
            },
        )
        assert live.status_code == 200, live.text
        by_key = {(row["type"], row["id"]): row for row in live.json()["items"]}
        assert by_key[("network_device", id_a)]["missing"] is False
        assert by_key[("network_device", id_a)]["ip"] == "192.168.77.21"
        assert by_key[("network_device", 9_999_999)]["missing"] is True
        assert by_key[("corax", 0)]["status"] == "ok"
    finally:
        client.delete(f"/api/v1/network/devices/{id_a}", headers=auth_headers)
        client.delete(f"/api/v1/network/devices/{id_b}", headers=auth_headers)


def test_network_map_scene_delete(client: TestClient, auth_headers: dict[str, str]):
    first = client.post(
        "/api/v1/network/map-scenes",
        headers=auth_headers,
        json={"title": "pytest-map-keep", "mode": "blank"},
    )
    second = client.post(
        "/api/v1/network/map-scenes",
        headers=auth_headers,
        json={"title": "pytest-map-delete", "mode": "blank"},
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    keep_id = first.json()["id"]
    drop_id = second.json()["id"]
    try:
        missing_route = client.delete("/api/v1/network/map-scenes/0", headers=auth_headers)
        assert missing_route.status_code == 404

        deleted = client.delete(f"/api/v1/network/map-scenes/{drop_id}", headers=auth_headers)
        assert deleted.status_code == 204, deleted.text

        gone = client.get(f"/api/v1/network/map-scenes/{drop_id}", headers=auth_headers)
        assert gone.status_code == 404

        listed = client.get("/api/v1/network/map-scenes", headers=auth_headers)
        assert listed.status_code == 200
        ids = {row["id"] for row in listed.json()}
        assert drop_id not in ids
        assert keep_id in ids
    finally:
        client.delete(f"/api/v1/network/map-scenes/{drop_id}", headers=auth_headers)
        client.delete(f"/api/v1/network/map-scenes/{keep_id}", headers=auth_headers)
