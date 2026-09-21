from __future__ import annotations

import heapq
import ipaddress
import json
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
    "vm": 4,
    "printer": 4,
    "unknown": 4,
}

_ENDPOINT_KINDS = frozenset({"computer", "printer"})
_ENDPOINT_TYPES = frozenset({"host", "pc", "computer", "printer", "vm"})
_STRONG_LINKS = frozenset({"lldp", "cdp", "mndp", "ndp", "fdp", "edp", "isdp", "hndp"})
_ENDPOINT_LINKS = _STRONG_LINKS | {"fdb"}
_PARENT_LINKS = _STRONG_LINKS | {"trace", "fdb"}
_GATEWAY_TYPES = frozenset({"router", "gateway", "firewall", "modem"})
_PATH_WEIGHT = {
    "lldp": 1,
    "cdp": 1,
    "mndp": 1,
    "ndp": 1,
    "fdp": 1,
    "edp": 1,
    "isdp": 1,
    "hndp": 1,
    "trace": 2,
    "fdb": 4,
    "manual": 5,
    "subnet": 12,
    "lan": 16,
}
_PATH_GAP = 220

_MAX_LAYOUT_NODES = 240
_MAX_ENDPOINTS = 24
_MAX_SUBNETS = 18
_MAX_PER_SUBNET = 28
_COL_GAP = 196
_ROW_GAP = 148
_ORIGIN_X = 80
_ORIGIN_Y = 80
_LAYER_WRAP = 7
_SUBNET_GAP_X = 140
_SUBNET_GAP_Y = 88
_SUBNET_INNER_X = 28
_SUBNET_INNER_Y = 52
_SUBNET_CELL_X = 200
_SUBNET_CELL_Y = 120
_SUBNET_COLS = 3
_GATEWAY_Y = 72
_GATEWAY_GAP = 240
_SUBNET_ROW_Y = 240


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
    if dtype in {"switch", "firewall", "ap", "server", "nas", "pc", "printer", "cloud", "corax", "vm"}:
        return dtype
    if dtype == "host":
        return "pc"
    return "unknown"


def _layer_for(kind: str | None, device_type: str | None) -> int:
    if kind == "computer":
        return 4
    if kind == "printer":
        return 4
    if kind == "corax":
        return 3
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


def _node_ips(node: dict[str, Any]) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()

    def add(raw: object) -> None:
        ip = _norm_ip(raw)
        if not ip or ip in seen:
            return
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return
        if addr.version != 4 or addr.is_loopback or addr.is_multicast or addr.is_unspecified:
            return
        seen.add(ip)
        found.append(ip)

    add(node.get("ip_address") or node.get("ip"))
    extras = node.get("extras") if isinstance(node.get("extras"), dict) else {}
    extra_ips = extras.get("ip_addresses") if isinstance(extras.get("ip_addresses"), list) else node.get("ip_addresses")
    if isinstance(extra_ips, list):
        for raw in extra_ips:
            add(raw)
    return found


def _slash24(ip: str) -> str | None:
    try:
        addr = ipaddress.ip_address(ip)
        if addr.version != 4 or addr.is_loopback or addr.is_multicast:
            return None
        return str(ipaddress.ip_network(f"{addr}/24", strict=False))
    except ValueError:
        return None


def _node_cidrs(node: dict[str, Any]) -> set[str]:
    return {cidr for ip in _node_ips(node) if (cidr := _slash24(ip))}


def _is_gateway(node: dict[str, Any], cidrs: set[str]) -> bool:
    kind = str(node.get("kind") or "").lower()
    if kind == "corax":
        return True
    dtype = str(node.get("device_type") or node.get("role") or "").lower()
    if dtype in _GATEWAY_TYPES:
        return True
    extras = node.get("extras") if isinstance(node.get("extras"), dict) else {}
    if extras.get("ip_forwarding") is True or node.get("ip_forwarding") is True:
        return True
    if len(cidrs) >= 2:
        return True
    host = str(node.get("label") or node.get("hostname") or node.get("sys_name") or "").lower()
    if host.startswith("gw") or host.startswith("gateway") or "gateway" in host or host.startswith("router"):
        return True
    return False


def _gateway_rank(node: dict[str, Any], cidrs: set[str]) -> int:
    dtype = str(node.get("device_type") or node.get("role") or "").lower()
    score = 10
    if str(node.get("kind") or "").lower() == "corax":
        score = 40
    elif dtype == "firewall":
        score = 90
    elif dtype in {"router", "gateway"}:
        score = 80
    elif dtype == "modem":
        score = 70
    if node.get("ip_forwarding") or (isinstance(node.get("extras"), dict) and node["extras"].get("ip_forwarding")):
        score += 15
    score += min(20, len(cidrs) * 8)
    return score


def _scene_node(node: dict[str, Any], x: float, y: float, parent: str | None = None) -> dict[str, Any]:
    nid = str(node["id"])
    item: dict[str, Any] = {
        "id": nid,
        "stencil": _stencil_for(node.get("kind"), node.get("device_type")),
        "x": round(x, 1),
        "y": round(y, 1),
        "bind": _bind_for(node),
        "label": (node.get("label") or nid)[:255],
    }
    if parent:
        item["parentGroupId"] = parent
    return item


def _collect_edges(
    edges: list[dict[str, Any]],
    placed_ids: set[str],
) -> list[dict[str, Any]]:
    scene_edges: list[dict[str, Any]] = []
    seen: set[str] = set()
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        src = str(edge.get("source") or "")
        tgt = str(edge.get("target") or "")
        if src not in placed_ids or tgt not in placed_ids or src == tgt:
            continue
        link_type = str(edge.get("link_type") or edge.get("linkType") or "").lower()
        if link_type == "lan" and (src.startswith("corax:") or tgt.startswith("corax:")):
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
                "link_type": str(edge.get("link_type") or edge.get("linkType") or "manual").lower(),
            }
        )
    return scene_edges


def _select_layout_nodes(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    endpoints: list[dict[str, Any]] = []
    gear: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict) or not node.get("id"):
            continue
        if _is_endpoint(node):
            endpoints.append(node)
        else:
            gear.append(node)

    linked_ids: set[str] = set()
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        src = str(edge.get("source") or "")
        tgt = str(edge.get("target") or "")
        link_type = str(edge.get("link_type") or edge.get("linkType") or "").lower()
        if link_type in _ENDPOINT_LINKS:
            linked_ids.add(src)
            linked_ids.add(tgt)
    linked_endpoints = [node for node in endpoints if str(node["id"]) in linked_ids][:_MAX_ENDPOINTS]
    selected = gear[:_MAX_LAYOUT_NODES]
    room = _MAX_LAYOUT_NODES - len(selected)
    if room > 0:
        selected.extend(linked_endpoints[:room])
    return selected


def _layout_layers(selected: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, Any]:
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
        link_type = str(edge.get("link_type") or edge.get("linkType") or "").lower()
        if src not in selected_ids or tgt not in selected_ids or src == tgt:
            continue
        if link_type and link_type not in _PARENT_LINKS:
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
                x = px + (slot - 0.5) * 88
                y = py + _ROW_GAP
            else:
                col = idx % _LAYER_WRAP
                row = idx // _LAYER_WRAP
                x = _ORIGIN_X + col * _COL_GAP
                y = _ORIGIN_Y + layer * _ROW_GAP + row * _ROW_GAP
            placed[nid] = (x, y)
            scene_nodes.append(_scene_node(node, x, y))

    scene = empty_scene()
    scene["nodes"] = scene_nodes
    scene["edges"] = _collect_edges(edges, set(placed))
    scene["viewport"] = {"x": 40, "y": 40, "zoom": 0.85}
    return normalize_scene(scene)


def _layout_subnets(selected: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, Any]:
    cidrs_of: dict[str, set[str]] = {str(n["id"]): _node_cidrs(n) for n in selected}
    all_cidrs = sorted({cidr for cidrs in cidrs_of.values() for cidr in cidrs})[:_MAX_SUBNETS]
    if len(all_cidrs) < 2:
        return _layout_layers(selected, edges)

    gateways = [n for n in selected if _is_gateway(n, cidrs_of.get(str(n["id"]), set()))]
    if not gateways:
        ranked = sorted(selected, key=lambda n: _gateway_rank(n, cidrs_of.get(str(n["id"]), set())), reverse=True)
        gateways = ranked[:1]
    gateway_ids = {str(n["id"]) for n in gateways}

    members: dict[str, list[dict[str, Any]]] = {cidr: [] for cidr in all_cidrs}
    home_cidr: dict[str, str] = {}
    for node in selected:
        nid = str(node["id"])
        if nid in gateway_ids:
            continue
        cidrs = cidrs_of.get(nid) or set()
        if not cidrs:
            continue
        cidr = sorted(cidrs)[0]
        if cidr not in members:
            continue
        if len(members[cidr]) >= _MAX_PER_SUBNET:
            continue
        members[cidr].append(node)
        home_cidr[nid] = cidr

    populated = [cidr for cidr in all_cidrs if members[cidr]]
    if len(populated) < 2:
        return _layout_layers(selected, edges)

    scene_nodes: list[dict[str, Any]] = []
    placed_ids: set[str] = set()

    gateways.sort(key=lambda n: (-_gateway_rank(n, cidrs_of.get(str(n["id"]), set())), str(n.get("label") or "")))
    gw_span = max(0, len(gateways) - 1)
    gw_origin = _ORIGIN_X + max(0, (len(populated) - 1) * (248 + _SUBNET_GAP_X) / 2 - gw_span * _GATEWAY_GAP / 2)
    for idx, node in enumerate(gateways):
        x = gw_origin + idx * _GATEWAY_GAP
        scene_nodes.append(_scene_node(node, x, _GATEWAY_Y))
        placed_ids.add(str(node["id"]))

    wrap = 3
    for sidx, cidr in enumerate(populated):
        rows = members[cidr]
        rows.sort(key=lambda n: (_layer_for(n.get("kind"), n.get("device_type") or n.get("role")), str(n.get("label") or "")))
        cols = min(_SUBNET_COLS, max(1, len(rows)))
        inner_rows = (len(rows) + cols - 1) // cols
        width = max(248.0, _SUBNET_INNER_X * 2 + cols * _SUBNET_CELL_X - 12)
        height = max(160.0, _SUBNET_INNER_Y + inner_rows * _SUBNET_CELL_Y + 16)
        col = sidx % wrap
        row = sidx // wrap
        gx = _ORIGIN_X + col * (width + _SUBNET_GAP_X)
        gy = _SUBNET_ROW_Y + row * (height + _SUBNET_GAP_Y)
        for midx, node in enumerate(rows):
            mx = _SUBNET_INNER_X + (midx % cols) * _SUBNET_CELL_X
            my = _SUBNET_INNER_Y + (midx // cols) * _SUBNET_CELL_Y
            scene_nodes.append(_scene_node(node, gx + mx, gy + my))
            placed_ids.add(str(node["id"]))

    scene_edges = _collect_edges(edges, placed_ids)
    seen_pairs = {
        (f"{e['source']}|{e['target']}" if e["source"] < e["target"] else f"{e['target']}|{e['source']}")
        for e in scene_edges
    }
    for cidr in populated:
        core = members[cidr][0]
        core_id = str(core["id"])
        for gw in gateways:
            gw_id = str(gw["id"])
            gw_cidrs = cidrs_of.get(gw_id) or set()
            kind = str(gw.get("kind") or "").lower()
            dtype = str(gw.get("device_type") or gw.get("role") or "").lower()
            l3 = dtype in _GATEWAY_TYPES or len(gw_cidrs) >= 2
            if kind == "corax":
                if cidr not in gw_cidrs:
                    continue
            elif cidr not in gw_cidrs and not l3:
                continue
            pair = f"{gw_id}|{core_id}" if gw_id < core_id else f"{core_id}|{gw_id}"
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            scene_edges.append(
                {
                    "id": f"subnet:{pair}"[:120],
                    "source": gw_id,
                    "target": core_id,
                    "link_type": "subnet",
                }
            )

    scene = empty_scene()
    scene["groups"] = []
    scene["nodes"] = scene_nodes
    scene["edges"] = scene_edges
    scene["viewport"] = {"x": 24, "y": 16, "zoom": 0.78}
    return normalize_scene(scene)


def layout_topology_scene(
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> dict[str, Any]:
    """Gear-first map. Several /24s cluster spatially around identified gateways, without frames."""
    selected = _select_layout_nodes(nodes, edges)
    cidrs = {cidr for node in selected for cidr in _node_cidrs(node)}
    if len(cidrs) >= 2:
        return _layout_subnets(selected, edges)
    return _layout_layers(selected, edges)


def port_handle_id(name: str | None) -> str | None:
    raw = (name or "").strip()
    if not raw:
        return None
    slug = re.sub(r"[^A-Za-z0-9]+", "-", raw).strip("-")[:48]
    return f"p:{slug}" if slug else None


def _norm_ip(value: object) -> str:
    return str(value or "").strip().split("/")[0].split(":")[0]


def resolve_topology_target(nodes: list[dict[str, Any]], needle: str) -> str | None:
    query = (needle or "").strip().lower()
    if not query:
        return None
    exact_ip: str | None = None
    exact_id: str | None = None
    labels: list[str] = []
    for node in nodes:
        if not isinstance(node, dict) or not node.get("id"):
            continue
        nid = str(node["id"])
        ip = _norm_ip(node.get("ip_address") or node.get("ip")).lower()
        if ip and ip == query:
            exact_ip = nid
            break
        if nid.lower() == query:
            exact_id = nid
        label = str(node.get("label") or node.get("hostname") or "").strip().lower()
        if query in label:
            labels.append(nid)
    if exact_ip:
        return exact_ip
    if exact_id:
        return exact_id
    if len(labels) == 1:
        return labels[0]
    return labels[0] if labels else None


def shortest_topology_path(
    edges: list[dict[str, Any]],
    src: str,
    dst: str,
) -> tuple[list[str], list[dict[str, Any]]] | None:
    if not src or not dst:
        return None
    if src == dst:
        return [src], []
    graph: dict[str, list[tuple[str, float, dict[str, Any]]]] = {}
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        a = str(edge.get("source") or "")
        b = str(edge.get("target") or "")
        if not a or not b or a == b:
            continue
        weight = float(_PATH_WEIGHT.get(str(edge.get("link_type") or edge.get("linkType") or "").lower(), 9))
        graph.setdefault(a, []).append((b, weight, edge))
        graph.setdefault(b, []).append((a, weight, edge))
    if src not in graph or dst not in graph:
        return None
    heap: list[tuple[float, str]] = [(0.0, src)]
    best = {src: 0.0}
    prev: dict[str, tuple[str, dict[str, Any]]] = {}
    while heap:
        cost, node = heapq.heappop(heap)
        if cost > best.get(node, 1e18):
            continue
        if node == dst:
            break
        for nxt, weight, edge in graph.get(node, []):
            cand = cost + weight
            if cand < best.get(nxt, 1e18):
                best[nxt] = cand
                prev[nxt] = (node, edge)
                heapq.heappush(heap, (cand, nxt))
    if dst not in prev:
        return None
    path = [dst]
    used: list[dict[str, Any]] = []
    cur = dst
    while cur != src:
        parent, edge = prev[cur]
        used.append(edge)
        path.append(parent)
        cur = parent
    path.reverse()
    used.reverse()
    return path, used


def stored_trace_chain(
    devices: list[Any],
    target: str,
    nodes_by_ip: dict[str, dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]] | None:
    """Build a hop chain from persisted traceroute extras — no live probing."""
    want = _norm_ip(target)
    if not want:
        return None
    index = nodes_by_ip or {}
    best: list[str] | None = None
    for device in devices:
        extras_raw = getattr(device, "extras_json", None)
        if extras_raw is None and isinstance(device, dict):
            extras_raw = device.get("extras_json") or device.get("extras")
        try:
            extras = json.loads(extras_raw or "{}") if isinstance(extras_raw, str) else extras_raw
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(extras, dict):
            continue
        traces: list[object] = []
        if isinstance(extras.get("trace_routes"), list):
            traces.extend(extras["trace_routes"])
        elif isinstance(extras.get("trace_route"), dict):
            traces.append(extras["trace_route"])
        for trace in traces:
            if not isinstance(trace, dict):
                continue
            hops = trace.get("hops")
            if not isinstance(hops, list) or not hops:
                continue
            ips: list[str] = []
            for hop in hops:
                if not isinstance(hop, dict):
                    continue
                ip = _norm_ip(hop.get("ip"))
                if ip and (not ips or ips[-1] != ip):
                    ips.append(ip)
            if not ips:
                continue
            last = ips[-1]
            target_ip = _norm_ip(trace.get("target_ip"))
            if last == want or target_ip == want or want in ips:
                if best is None or len(ips) > len(best):
                    best = ips
    if not best:
        return None
    chain_nodes: list[dict[str, Any]] = []
    chain_edges: list[dict[str, Any]] = []
    seen: set[str] = set()
    ids: list[str] = []
    for ip in best:
        hit = index.get(ip)
        if hit and hit.get("id"):
            nid = str(hit["id"])
            if nid not in seen:
                chain_nodes.append(hit)
                seen.add(nid)
            ids.append(nid)
            continue
        nid = f"hop:{ip}"
        if nid not in seen:
            chain_nodes.append(
                {
                    "id": nid,
                    "kind": "network_device",
                    "ref_id": 0,
                    "label": ip,
                    "device_type": "router",
                    "ip_address": ip,
                }
            )
            seen.add(nid)
        ids.append(nid)
    for left, right in zip(ids, ids[1:]):
        if left == right:
            continue
        chain_edges.append(
            {
                "id": f"trace:{left}|{right}",
                "source": left,
                "target": right,
                "link_type": "trace",
            }
        )
    if len(ids) < 2:
        return None
    return chain_nodes, chain_edges


def pick_path_start(
    scene_nodes: list[dict[str, Any]],
    topo_ids: set[str],
    *,
    preferred: str | None = None,
    avoid: str | None = None,
) -> str | None:
    if preferred and preferred in topo_ids:
        return preferred
    for node in scene_nodes:
        if not isinstance(node, dict):
            continue
        nid = str(node.get("id") or "")
        bind = node.get("bind") if isinstance(node.get("bind"), dict) else None
        topo_id = nid if nid in topo_ids else None
        if bind:
            btype = str(bind.get("type") or "")
            bid = bind.get("id")
            if btype == "corax":
                topo_id = "corax:self"
            elif btype and bid is not None:
                topo_id = f"{btype}:{int(bid)}"
        if topo_id and topo_id in topo_ids and topo_id != avoid and not str(topo_id).startswith("corax:"):
            return topo_id
    for node in scene_nodes:
        nid = str((node or {}).get("id") or "")
        if nid in topo_ids and nid != avoid:
            return nid
    if avoid and avoid in topo_ids:
        return None
    return next(iter(topo_ids), None) if len(topo_ids) == 1 else None


def merge_trace_into_scene(
    scene: dict[str, Any],
    path_nodes: list[dict[str, Any]],
    path_edges: list[dict[str, Any]],
    *,
    anchor_id: str | None = None,
) -> dict[str, Any]:
    """Place a hop path left-to-right, keeping nodes already on the canvas."""
    current = json.loads(json.dumps(scene if isinstance(scene, dict) else empty_scene()))
    existing = {str(n.get("id")): n for n in current.get("nodes") or [] if isinstance(n, dict) and n.get("id")}
    path_ids = [str(n.get("id")) for n in path_nodes if isinstance(n, dict) and n.get("id")]
    if not path_ids:
        return normalize_scene(current)

    origin_id = anchor_id if anchor_id in existing else next((nid for nid in path_ids if nid in existing), None)
    if origin_id:
        origin_x = float(existing[origin_id].get("x") or 80)
        origin_y = float(existing[origin_id].get("y") or 80)
    else:
        xs = [float(n.get("x") or 0) for n in existing.values()]
        origin_x = (max(xs) + 220) if xs else 80.0
        origin_y = 120.0

    cursor_x = origin_x
    cursor_y = origin_y
    for index, node in enumerate(path_nodes):
        if not isinstance(node, dict) or not node.get("id"):
            continue
        nid = str(node["id"])
        if nid in existing:
            cursor_x = float(existing[nid].get("x") or cursor_x)
            cursor_y = float(existing[nid].get("y") or cursor_y)
            continue
        cursor_x = cursor_x + _PATH_GAP if index else origin_x
        bind = _bind_for(node)
        if nid.startswith("hop:"):
            bind = None
        placed = {
            "id": nid,
            "stencil": _stencil_for(node.get("kind"), node.get("device_type")),
            "x": round(cursor_x, 1),
            "y": round(cursor_y + (12 if index % 2 else 0), 1),
            "bind": bind,
            "label": (node.get("label") or nid)[:255],
        }
        current.setdefault("nodes", []).append(placed)
        existing[nid] = placed

    seen_pairs: set[str] = set()
    for edge in current.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        a, b = str(edge.get("source") or ""), str(edge.get("target") or "")
        if a and b:
            seen_pairs.add(f"{a}|{b}" if a < b else f"{b}|{a}")
    for edge in path_edges:
        if not isinstance(edge, dict):
            continue
        src = str(edge.get("source") or "")
        tgt = str(edge.get("target") or "")
        if not src or not tgt or src == tgt or src not in existing or tgt not in existing:
            continue
        pair = f"{src}|{tgt}" if src < tgt else f"{tgt}|{src}"
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        eid = str(edge.get("id") or f"trace:{pair}")[:120]
        current.setdefault("edges", []).append(
            {
                "id": eid,
                "source": src,
                "target": tgt,
                "local_port": edge.get("local_port") or edge.get("localPort"),
                "remote_port": edge.get("remote_port") or edge.get("remotePort"),
                "link_type": str(edge.get("link_type") or "trace"),
            }
        )
    return normalize_scene(current)
