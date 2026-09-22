from __future__ import annotations

import base64
import binascii
import json
import math
import re
from typing import Any

from fastapi import HTTPException

from app.text_sanitize import pg_text

SCENE_VERSION = 1
SCENE_MAX_BYTES = 2_500_000
MAX_GROUPS = 80
MAX_NODES = 4000
MAX_EDGES = 4000
MAX_HIDDEN = 4000
MAX_IMAGES = 24
MAX_IMAGE_CHARS = 420_000

STENCILS = frozenset(
    {
        "switch",
        "router",
        "firewall",
        "ap",
        "server",
        "nas",
        "pc",
        "printer",
        "cloud",
        "corax",
        "unknown",
        "note",
        "image",
    }
)
DECOR_STENCILS = frozenset({"note", "image"})
_IMAGE_DATA_RE = re.compile(
    r"^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$",
    re.IGNORECASE,
)
GROUP_KINDS = frozenset({"room", "rack", "subnet"})
BIND_TYPES = frozenset({"network_device", "computer", "printer", "corax", "zabbix"})
LINK_ENDPOINT_TYPES = frozenset({"network_device", "computer", "printer", "corax"})
SCENE_LINK_TYPES = frozenset(
    {"lldp", "cdp", "mndp", "ndp", "fdp", "edp", "isdp", "hndp", "fdb", "trace", "lan", "manual", "subnet"}
)

EMPTY_SCENE: dict[str, Any] = {
    "version": SCENE_VERSION,
    "groups": [],
    "nodes": [],
    "edges": [],
    "hiddenNodeIds": [],
    "viewport": None,
}


def empty_scene() -> dict[str, Any]:
    return json.loads(json.dumps(EMPTY_SCENE))


def _num(value: object, *, default: float = 0.0, lo: float | None = None, hi: float | None = None) -> float:
    try:
        n = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        n = default
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def _str(value: object, *, max_len: int, default: str = "") -> str:
    cleaned = pg_text(value, max_len=max_len)
    return cleaned if cleaned is not None else default


def _opt_str(value: object, *, max_len: int) -> str | None:
    s = _str(value, max_len=max_len)
    return s or None


def _cable_points(value: object) -> list[dict[str, float]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, float]] = []
    for raw in value[:8]:
        if not isinstance(raw, dict):
            continue
        try:
            x = float(raw.get("x"))
            y = float(raw.get("y"))
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if abs(x) > 200_000 or abs(y) > 200_000:
            continue
        out.append({"x": x, "y": y})
    return out


def _sanitize_image_src(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    raw_src = value.strip()
    if not raw_src or len(raw_src) > MAX_IMAGE_CHARS:
        return None
    match = _IMAGE_DATA_RE.match(raw_src)
    if not match:
        return None
    kind = match.group(1).lower()
    payload = match.group(2)
    pad = (-len(payload)) % 4
    try:
        blob = base64.b64decode(payload + ("=" * pad), validate=False)
    except (ValueError, binascii.Error):
        return None
    if len(blob) < 24:
        return None
    if kind in {"jpeg", "jpg"} and not blob.startswith(b"\xff\xd8"):
        return None
    if kind == "png" and not blob.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    if kind == "webp" and not (blob.startswith(b"RIFF") and b"WEBP" in blob[:16]):
        return None
    mime = "jpeg" if kind == "jpg" else kind
    return f"data:image/{mime};base64,{payload}"


def normalize_scene(raw: object) -> dict[str, Any]:
    if raw is None:
        return empty_scene()
    if isinstance(raw, str):
        text = raw.strip() or "{}"
        if len(text.encode("utf-8")) > SCENE_MAX_BYTES:
            raise HTTPException(status_code=400, detail="Сцена карты слишком большая")
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Некорректный JSON сцены") from exc
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="Сцена карты должна быть объектом")
    dumped = json.dumps(raw, ensure_ascii=False)
    if len(dumped.encode("utf-8")) > SCENE_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Сцена карты слишком большая")

    version = int(raw.get("version") or SCENE_VERSION)
    if version != SCENE_VERSION:
        raise HTTPException(status_code=400, detail="Неподдерживаемая версия сцены")

    groups_in = raw.get("groups") or []
    nodes_in = raw.get("nodes") or []
    edges_in = raw.get("edges") or []
    hidden_in = raw.get("hiddenNodeIds") or []
    if not isinstance(groups_in, list) or not isinstance(nodes_in, list) or not isinstance(edges_in, list):
        raise HTTPException(status_code=400, detail="Некорректная структура сцены")
    if not isinstance(hidden_in, list):
        raise HTTPException(status_code=400, detail="Некорректный список скрытых узлов")
    if len(groups_in) > MAX_GROUPS or len(nodes_in) > MAX_NODES or len(edges_in) > MAX_EDGES:
        raise HTTPException(status_code=400, detail="Слишком много элементов на карте")
    if len(hidden_in) > MAX_HIDDEN:
        raise HTTPException(status_code=400, detail="Слишком много скрытых узлов")

    groups: list[dict[str, Any]] = []
    seen_groups: set[str] = set()
    for item in groups_in:
        if not isinstance(item, dict):
            continue
        gid = _str(item.get("id"), max_len=80)
        if not gid or gid in seen_groups:
            continue
        seen_groups.add(gid)
        kind = _str(item.get("kind"), max_len=16, default="room").lower()
        if kind not in GROUP_KINDS:
            kind = "room"
        default_title = "Подсеть" if kind == "subnet" else "Серверная"
        group: dict[str, Any] = {
            "id": gid,
            "title": _str(item.get("title"), max_len=120, default=default_title),
            "kind": kind,
            "x": _num(item.get("x")),
            "y": _num(item.get("y")),
            "width": _num(item.get("width"), default=420, lo=160, hi=2400),
            "height": _num(item.get("height"), default=280, lo=120, hi=1800),
        }
        cidr = _opt_str(item.get("cidr"), max_len=64)
        if cidr:
            group["cidr"] = cidr
        if item.get("collapsed"):
            group["collapsed"] = True
        if item.get("locked") is True:
            group["locked"] = True
        groups.append(group)

    nodes: list[dict[str, Any]] = []
    seen_nodes: set[str] = set()
    image_count = 0
    for item in nodes_in:
        if not isinstance(item, dict):
            continue
        nid = _str(item.get("id"), max_len=120)
        if not nid or nid in seen_nodes:
            continue
        seen_nodes.add(nid)
        stencil = _str(item.get("stencil"), max_len=32, default="unknown").lower()
        if stencil not in STENCILS:
            stencil = "unknown"
        parent = _opt_str(item.get("parentGroupId"), max_len=80)
        if parent and parent not in seen_groups:
            parent = None
        bind_raw = item.get("bind")
        bind = None
        if stencil not in DECOR_STENCILS and isinstance(bind_raw, dict):
            btype = _str(bind_raw.get("type"), max_len=32).lower()
            try:
                bid = int(bind_raw.get("id"))
            except (TypeError, ValueError):
                bid = 0
            if btype in BIND_TYPES:
                bind = {"type": btype, "id": bid}
        image_src = _sanitize_image_src(item.get("imageSrc") or item.get("image_src"))
        width = int(_num(item.get("width"), default=0, lo=0, hi=1600)) or None
        height = int(_num(item.get("height"), default=0, lo=0, hi=1200)) or None
        if stencil != "image":
            image_src = None
        elif not image_src:
            continue
        if stencil == "image":
            if image_count >= MAX_IMAGES:
                continue
            image_count += 1
            width = width or 220
            height = height or 140
        node: dict[str, Any] = {
            "id": nid,
            "stencil": stencil,
            "x": _num(item.get("x")),
            "y": _num(item.get("y")),
            "parentGroupId": parent,
            "bind": bind,
            "label": _opt_str(item.get("label"), max_len=500 if stencil == "note" else 255),
        }
        if image_src:
            node["imageSrc"] = image_src
        if width:
            node["width"] = width
        if height:
            node["height"] = height
        if item.get("locked") is True:
            node["locked"] = True
        if stencil not in DECOR_STENCILS:
            raw_ports = item.get("portCount")
            if raw_ports is None:
                raw_ports = item.get("port_count")
            try:
                port_count = int(raw_ports)
            except (TypeError, ValueError):
                port_count = 0
            if 1 <= port_count <= 96:
                node["portCount"] = port_count
        nodes.append(node)

    edges: list[dict[str, Any]] = []
    seen_edges: set[str] = set()
    for item in edges_in:
        if not isinstance(item, dict):
            continue
        eid = _str(item.get("id"), max_len=120)
        source = _str(item.get("source"), max_len=120)
        target = _str(item.get("target"), max_len=120)
        if not eid or not source or not target or source == target or eid in seen_edges:
            continue
        seen_edges.add(eid)
        link_type = _str(item.get("link_type") or item.get("linkType"), max_len=16).lower()
        if link_type not in SCENE_LINK_TYPES:
            link_type = "manual"
        edge = {
            "id": eid,
            "source": source,
            "target": target,
            "local_port": _opt_str(item.get("local_port") or item.get("localPort"), max_len=128),
            "remote_port": _opt_str(item.get("remote_port") or item.get("remotePort"), max_len=128),
            "link_type": link_type,
        }
        points = _cable_points(item.get("points"))
        if points:
            edge["points"] = points
        edges.append(edge)

    hidden: list[str] = []
    seen_hidden: set[str] = set()
    for item in hidden_in:
        hid = _str(item, max_len=120)
        if not hid or hid in seen_hidden:
            continue
        seen_hidden.add(hid)
        hidden.append(hid)

    viewport = None
    vp = raw.get("viewport")
    if isinstance(vp, dict):
        viewport = {
            "x": _num(vp.get("x")),
            "y": _num(vp.get("y")),
            "zoom": _num(vp.get("zoom"), default=1.0, lo=0.05, hi=2.5),
        }

    return {
        "version": SCENE_VERSION,
        "groups": groups,
        "nodes": nodes,
        "edges": edges,
        "hiddenNodeIds": hidden,
        "viewport": viewport,
    }


def dumps_scene(scene: dict[str, Any]) -> str:
    return json.dumps(scene, ensure_ascii=False, separators=(",", ":"))
