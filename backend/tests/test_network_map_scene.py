from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.network_link_builder import AUTO_LINK_TYPES
from app.network_map_scene import normalize_scene


def test_auto_link_types_do_not_include_manual():
    assert "manual" not in AUTO_LINK_TYPES
    assert "lldp" in AUTO_LINK_TYPES
    assert "mndp" in AUTO_LINK_TYPES
    assert "ndp" in AUTO_LINK_TYPES
    assert "lan" not in AUTO_LINK_TYPES


def test_normalize_scene_defaults_and_strips_junk():
    scene = normalize_scene(
        {
            "version": 1,
            "groups": [
                {"id": "g1", "title": "Серверная A", "kind": "room", "x": 10, "y": 20, "width": 400, "height": 300},
                {"id": "g1", "title": "dup"},
            ],
            "nodes": [
                {
                    "id": "network_device:1",
                    "stencil": "switch",
                    "x": 40,
                    "y": 80,
                    "parentGroupId": "g1",
                    "bind": {"type": "network_device", "id": 1},
                    "label": "sw-core",
                },
                {"id": "logical:x", "stencil": "nope", "parentGroupId": "missing"},
            ],
            "edges": [{"id": "e1", "source": "a", "target": "b", "localPort": "Gi1/0/1"}],
            "hiddenNodeIds": ["computer:9", "computer:9", ""],
            "viewport": {"x": 1, "y": 2, "zoom": 0.4},
        }
    )
    assert scene["version"] == 1
    assert len(scene["groups"]) == 1
    assert scene["groups"][0]["title"] == "Серверная A"
    assert len(scene["nodes"]) == 2
    assert scene["nodes"][0]["bind"] == {"type": "network_device", "id": 1}
    assert scene["nodes"][1]["stencil"] == "unknown"
    assert scene["nodes"][1]["parentGroupId"] is None
    assert scene["edges"][0]["local_port"] == "Gi1/0/1"
    assert scene["hiddenNodeIds"] == ["computer:9"]
    assert scene["viewport"]["zoom"] == 0.4


def test_normalize_scene_keeps_zabbix_bind():
    scene = normalize_scene(
        {
            "version": 1,
            "nodes": [
                {
                    "id": "logical:z",
                    "stencil": "server",
                    "x": 1,
                    "y": 2,
                    "bind": {"type": "zabbix", "id": 10432},
                    "label": "core-sw",
                }
            ],
        }
    )
    assert scene["nodes"][0]["bind"] == {"type": "zabbix", "id": 10432}


def test_normalize_scene_keeps_note_and_image():
    png = (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    scene = normalize_scene(
        {
            "version": 1,
            "nodes": [
                {"id": "logical:note", "stencil": "note", "x": 10, "y": 20, "label": "WAN"},
                {
                    "id": "logical:logo",
                    "stencil": "image",
                    "x": 40,
                    "y": 50,
                    "label": "logo",
                    "imageSrc": png,
                    "width": 240,
                    "height": 80,
                    "bind": {"type": "zabbix", "id": 1},
                },
                {"id": "logical:bad-img", "stencil": "image", "imageSrc": "javascript:alert(1)"},
                {"id": "logical:http", "stencil": "image", "imageSrc": "https://evil.example/x.png"},
            ],
        }
    )
    assert [n["stencil"] for n in scene["nodes"]] == ["note", "image"]
    assert scene["nodes"][0]["label"] == "WAN"
    assert scene["nodes"][1]["imageSrc"].startswith("data:image/png;base64,")
    assert scene["nodes"][1]["width"] == 240
    assert scene["nodes"][1]["bind"] is None


def test_normalize_scene_keeps_equipment_size():
    scene = normalize_scene(
        {
            "version": 1,
            "nodes": [
                {"id": "logical:sw", "stencil": "switch", "x": 10, "y": 20, "width": 280, "height": 96, "label": "core"},
            ],
            "edges": [{"id": "e1", "source": "a", "target": "b", "linkType": "trace"}],
        }
    )
    assert scene["nodes"][0]["width"] == 280
    assert scene["nodes"][0]["height"] == 96
    assert scene["edges"][0]["link_type"] == "trace"


def test_normalize_scene_rejects_bad_version():
    with pytest.raises(HTTPException) as ei:
        normalize_scene({"version": 9, "groups": [], "nodes": [], "edges": [], "hiddenNodeIds": []})
    assert ei.value.status_code == 400
