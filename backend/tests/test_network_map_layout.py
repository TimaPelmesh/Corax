from app.network_map_layout import layout_topology_scene, port_handle_id
from app.network_snmp_discover import _private_slash24


def test_layout_places_endpoint_below_switch():
    scene = layout_topology_scene(
        [
            {"id": "network_device:1", "kind": "network_device", "ref_id": 1, "label": "sw", "device_type": "switch"},
            {"id": "network_device:3", "kind": "network_device", "ref_id": 3, "label": "ap", "device_type": "ap"},
            {"id": "corax:self", "kind": "corax", "ref_id": 0, "label": "Corax", "device_type": "corax"},
        ],
        [{"id": "e1", "source": "network_device:1", "target": "network_device:3", "local_port": "Gi1/0/1", "link_type": "lldp"}],
    )
    by_id = {n["id"]: n for n in scene["nodes"]}
    assert by_id["network_device:3"]["y"] > by_id["network_device:1"]["y"]
    assert by_id["network_device:1"]["bind"] == {"type": "network_device", "id": 1}
    assert scene["edges"][0]["local_port"] == "Gi1/0/1"


def test_layout_skips_unlinked_pcs():
    scene = layout_topology_scene(
        [
            {"id": "network_device:1", "kind": "network_device", "ref_id": 1, "label": "sw", "device_type": "switch"},
            {"id": "computer:2", "kind": "computer", "ref_id": 2, "label": "pc", "device_type": "computer"},
            {"id": "network_device:9", "kind": "network_device", "ref_id": 9, "label": "ПК · desk", "device_type": "host"},
        ],
        [{"id": "e1", "source": "network_device:1", "target": "computer:2", "link_type": "subnet"}],
    )
    ids = {n["id"] for n in scene["nodes"]}
    assert "network_device:1" in ids
    assert "computer:2" not in ids
    assert "network_device:9" not in ids


def test_layout_keeps_pc_with_lldp():
    scene = layout_topology_scene(
        [
            {"id": "network_device:1", "kind": "network_device", "ref_id": 1, "label": "sw", "device_type": "switch"},
            {"id": "computer:2", "kind": "computer", "ref_id": 2, "label": "pc", "device_type": "computer"},
        ],
        [{"id": "e1", "source": "network_device:1", "target": "computer:2", "link_type": "lldp"}],
    )
    ids = {n["id"] for n in scene["nodes"]}
    assert "computer:2" in ids


def test_layout_wraps_wide_switch_row():
    nodes = [
        {"id": f"network_device:{i}", "kind": "network_device", "ref_id": i, "label": f"sw{i}", "device_type": "switch"}
        for i in range(1, 10)
    ]
    scene = layout_topology_scene(nodes, [])
    xs = [n["x"] for n in scene["nodes"]]
    ys = [n["y"] for n in scene["nodes"]]
    assert max(xs) - min(xs) < 168 * 8
    assert max(ys) > min(ys)


def test_port_handle_id_slug():
    assert port_handle_id("Gi1/0/1") == "p:Gi1-0-1"
    assert port_handle_id("") is None


def test_layout_does_not_hang_gear_off_corax_lan():
    scene = layout_topology_scene(
        [
            {"id": "corax:self", "kind": "corax", "ref_id": 0, "label": "Corax", "device_type": "corax"},
            {"id": "network_device:1", "kind": "network_device", "ref_id": 1, "label": "gw", "device_type": "router"},
            {"id": "network_device:2", "kind": "network_device", "ref_id": 2, "label": "sw", "device_type": "switch"},
        ],
        [
            {"id": "e-lan", "source": "corax:self", "target": "network_device:1", "link_type": "lan"},
            {"id": "e-lldp", "source": "network_device:1", "target": "network_device:2", "link_type": "lldp"},
        ],
    )
    by_id = {n["id"]: n for n in scene["nodes"]}
    assert by_id["network_device:2"]["y"] > by_id["network_device:1"]["y"]
    edge_ids = {e["id"] for e in scene["edges"]}
    assert "e-lan" not in edge_ids
    assert any("network_device:1" in (e["source"], e["target"]) and "network_device:2" in (e["source"], e["target"]) for e in scene["edges"])


def test_shortest_path_prefers_lldp_over_lan():
    from app.network_map_layout import shortest_topology_path

    found = shortest_topology_path(
        [
            {"id": "weak", "source": "a", "target": "c", "link_type": "lan"},
            {"id": "ab", "source": "a", "target": "b", "link_type": "lldp"},
            {"id": "bc", "source": "b", "target": "c", "link_type": "trace"},
        ],
        "a",
        "c",
    )
    assert found is not None
    path, used = found
    assert path == ["a", "b", "c"]
    assert [e["id"] for e in used] == ["ab", "bc"]


def test_merge_trace_places_foreign_subnet_hops():
    from app.network_map_layout import merge_trace_into_scene, stored_trace_chain

    class _Dev:
        extras_json = (
            '{"trace_routes":[{"target_ip":"10.80.1.5","hops":['
            '{"ip":"10.0.0.1"},{"ip":"10.50.0.1"},{"ip":"10.80.1.5"}]}]}'
        )

    index = {
        "10.0.0.1": {
            "id": "network_device:8",
            "kind": "network_device",
            "ref_id": 8,
            "label": "core",
            "device_type": "switch",
            "ip_address": "10.0.0.1",
        }
    }
    chain = stored_trace_chain([_Dev()], "10.80.1.5", index)
    assert chain is not None
    nodes, edges = chain
    scene = merge_trace_into_scene(
        {
            "version": 1,
            "nodes": [
                {
                    "id": "network_device:8",
                    "stencil": "switch",
                    "x": 40,
                    "y": 80,
                    "bind": {"type": "network_device", "id": 8},
                    "label": "core",
                }
            ],
        },
        nodes,
        edges,
        anchor_id="network_device:8",
    )
    ids = [n["id"] for n in scene["nodes"]]
    assert "network_device:8" in ids
    assert "hop:10.50.0.1" in ids
    assert "hop:10.80.1.5" in ids
    assert any(e.get("link_type") == "trace" for e in scene["edges"])


def test_neighbor_ip_becomes_slash24():
    assert _private_slash24("10.20.30.40") == "10.20.30.0/24"
    assert _private_slash24("8.8.8.8") is None
    assert _private_slash24("192.168.1.0") is None
