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


def test_port_handle_id_slug():
    assert port_handle_id("Gi1/0/1") == "p:Gi1-0-1"
    assert port_handle_id("") is None


def test_neighbor_ip_becomes_slash24():
    assert _private_slash24("10.20.30.40") == "10.20.30.0/24"
    assert _private_slash24("8.8.8.8") is None
    assert _private_slash24("192.168.1.0") is None
