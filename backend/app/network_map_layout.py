from __future__ import annotations

import re
from typing import Any

from app.network_map_scene import empty_scene, normalize_scene

_LAYER = {
    "corax": 0,
    "cloud": 0,
    "firewall": 1,
    "router": 1,
    "gateway": 1,
    "modem": 1,
    "switch": 2,
    "controller": 2,
    "ap": 3,
    "server": 3,
    "nas": 3,
    "voip": 3,
    "ups": 3,
    "camera": 3,
    "pc": 4,
    "host": 4,
    "printer": 4,
    "unknown": 4,
}

_ENDPOINT_KINDS = frozenset({"computer", "printer"})
_ENDPOINT_TYPES = frozenset({"host", "pc", "computer", "printer"})
_STRONG_LINKS = frozenset({"lldp", "cdp", "mndp", "ndp", "fdp", "edp", "isdp", "hndp"})

_MAX_LAYOUT_NODES = 240
_MAX_ENDPOINTS = 24
_COL_GAP = 220
_ROW_GAP = 160
_ORIGIN_X = 80
_ORIGIN_Y = 80


def _stencil_for(kind: str | None, device_type: str | None) -> str:
    if kind == "corax":
        return "corax"
    if kind == "computer":
        return "pc"
    if kind == "printer":
        return "printer"
    dtype = (device_type or "").lower()
    if dtype in {"gateway", "router", "modem"}:
        return "router"
    if dtype == "controller":
        return "switch"
    if dtype in {"switch", "firewall", "ap", "server", "nas", "pc", "printer", "cloud", "corax"}:
        return dtype
    return "unknown"


def _layer_for(kind: str | None, device_type: str | None) -> int:
    if kind == "corax":
        return 0
    if kind == "computer":
        return 4
    if kind == "printer":
        return 4
    return _LAYER.get((device_type or kind or "unknown").lower(), 4)


def _is_endpoint(node: dict[str, Any]) -> bool:
    kind = str(node.get("kind") or "").lower()
    dtype = str(node.get("device_type") or node.get("role") or "").lower()
    if kind in _ENDPOINT_KINDS:
        return True
    if dtype in _ENDPOINT_TYPES:
        return True
    return False


def _bind_for(node: dict[str, Any]) -> dict[str, Any] | None:
    kind = str(node.get("kind") or "")
    ref = int(node.get("ref_id") or 0)
    if kind == "corax":
        return {"type": "corax", "id": 0}
    if kind in {"network_device", "computer", "printer"}:
        return {"type": kind, "id": ref}
    return None


def layout_topology_scene(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> dict[str, Any]:
    """Hierarchical layout: network gear first. PCs/printers only if they have a discovery link."""
    endpoints: list[dict[str, Any]] = []
    gear: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict) or not node.get("id"):
            continue
        if _is_endpoint(node):
            endpoints.append(node)
        else:
            gear.append(node)

    linked_endpoints: list[dict[str, Any]] = []
    strong_pairs: set[str] = set()
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        src = str(edge.get("source") or "")
        tgt = str(edge.get("target") or "")
        link_type = str(edge.get("link_type") or edge.get("linkType") or "").lower()
        if link_type in _STRONG_LINKS:
            strong_pairs.add(src)
            strong_pairs.add(tgt)
    for node in endpoints:
        nid = str(node["id"])
        if nid in strong_pairs:
            linked_endpoints.append(node)
    linked_endpoints = linked_endpoints[:_MAX_ENDPOINTS]

    selected = gear[:_MAX_LAYOUT_NODES]
    room = _MAX_LAYOUT_NODES - len(selected)
    if room > 0:
        selected.extend(linked_endpoints[:room])
    selected_ids = {str(n["id"]) for n in selected}

    buckets: dict[int, list[dict[str, Any]]] = {0: [], 1: [], 2: [], 3: [], 4: []}
    for node in selected:
        layer = _layer_for(node.get("kind"), node.get("device_type") or node.get("role"))
        buckets[layer].append(node)

    neighbor_of: dict[str, str] = {}
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        src = str(edge.get("source") or "")
        tgt = str(edge.get("target") or "")
        if src not in selected_ids or tgt not in selected_ids or src == tgt:
            continue
        src_layer = next((i for i, rows in buckets.items() if any(n.get("id") == src for n in rows)), 4)
        tgt_layer = next((i for i, rows in buckets.items() if any(n.get("id") == tgt for n in rows)), 4)
        if src_layer < tgt_layer:
            neighbor_of.setdefault(tgt, src)
        elif tgt_layer < src_layer:
            neighbor_of.setdefault(src, tgt)

    placed: dict[str, tuple[float, float]] = {}
    scene_nodes: list[dict[str, Any]] = []
    parent_slot: dict[str, int] = {}

    for layer in range(5):
        rows = buckets[layer]
        rows.sort(key=lambda n: (neighbor_of.get(str(n.get("id") or ""), ""), str(n.get("label") or n.get("id") or "")))
        for idx, node in enumerate(rows):
            nid = str(node["id"])
            parent = neighbor_of.get(nid)
            if parent and parent in placed:
                slot = parent_slot.get(parent, 0)
                parent_slot[parent] = slot + 1
                px, py = placed[parent]
                x = px + (slot - 0.5) * 70
                y = py + _ROW_GAP
            else:
                x = _ORIGIN_X + idx * _COL_GAP
                y = _ORIGIN_Y + layer * _ROW_GAP
            placed[nid] = (x, y)
            bind = _bind_for(node)
            scene_nodes.append(
                {
                    "id": nid,
                    "stencil": _stencil_for(node.get("kind"), node.get("device_type")),
                    "x": round(x, 1),
                    "y": round(y, 1),
                    "bind": bind,
                    "label": (node.get("label") or nid)[:255],
                }
            )

    scene_edges: list[dict[str, Any]] = []
    seen: set[str] = set()
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        src = str(edge.get("source") or "")
        tgt = str(edge.get("target") or "")
        if src not in placed or tgt not in placed or src == tgt:
            continue
        pair = f"{src}|{tgt}" if src < tgt else f"{tgt}|{src}"
        if pair in seen:
            continue
        seen.add(pair)
        eid = str(edge.get("id") or f"auto:{pair}")
        scene_edges.append(
            {
                "id": eid[:120],
                "source": src,
                "target": tgt,
                "local_port": edge.get("local_port") or edge.get("localPort"),
                "remote_port": edge.get("remote_port") or edge.get("remotePort"),
            }
        )

    scene = empty_scene()
    scene["nodes"] = scene_nodes
    scene["edges"] = scene_edges
    scene["viewport"] = {"x": 40, "y": 40, "zoom": 0.85}
    return normalize_scene(scene)


def port_handle_id(name: str | None) -> str | None:
    raw = (name or "").strip()
    if not raw:
        return None
    slug = re.sub(r"[^A-Za-z0-9]+", "-", raw).strip("-")[:48]
    return f"p:{slug}" if slug else None
