"""Docker Swarm over SSH. The browser never sends a command string.

Each call is a fixed docker invocation. A service name is one token, replicas
are an integer, and nothing here opens a shell, a container, or a stack file.
"""

from __future__ import annotations

import json
import re
import shlex

_SERVICE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")
_MAX_REPLICAS = 32

_INFO = "docker info --format '{{.Swarm.LocalNodeState}}|{{.Swarm.ControlAvailable}}'"
_NODES = "docker node ls --format '{{json .}}'"
_SERVICES = "docker service ls --format '{{json .}}'"


def service_name(raw: str) -> str:
    name = (raw or "").strip()
    if not _SERVICE.fullmatch(name) or ".." in name:
        raise ValueError("Некорректное имя службы Swarm")
    return name


def replica_count(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > _MAX_REPLICAS:
        raise ValueError(f"Число реплик от 0 до {_MAX_REPLICAS}")
    return value


def overview_commands() -> list[tuple[str, float]]:
    return [(_INFO, 20), (_NODES, 25), (_SERVICES, 25)]


def scale_commands(name: str, replicas: int) -> list[tuple[str, float]]:
    target = shlex.quote(f"{service_name(name)}={replica_count(replicas)}")
    return [(f"docker service scale {target}", 60), (_SERVICES, 25)]


def rollback_commands(name: str) -> list[tuple[str, float]]:
    target = shlex.quote(service_name(name))
    return [(f"docker service rollback {target}", 90), (_SERVICES, 25)]


def parse_swarm_info(text: str) -> tuple[str, bool]:
    line = ""
    for raw in (text or "").splitlines():
        if "|" in raw:
            line = raw.strip()
    if not line:
        return "", False
    state, _, manager = line.partition("|")
    return state.strip(), manager.strip().lower() == "true"


def parse_json_lines(text: str) -> list[dict]:
    rows: list[dict] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line.startswith("{"):
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows


def _text(row: dict, *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def nodes_from_output(text: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for row in parse_json_lines(text):
        out.append(
            {
                "id": _text(row, "ID", "Id", "id")[:32],
                "hostname": _text(row, "Hostname", "hostname")[:255],
                "status": _text(row, "Status", "status")[:32],
                "availability": _text(row, "Availability", "availability")[:32],
                "manager": _text(row, "ManagerStatus", "manager")[:64],
                "engine": _text(row, "EngineVersion", "engine")[:32],
            }
        )
    return out


def services_from_output(text: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for row in parse_json_lines(text):
        out.append(
            {
                "id": _text(row, "ID", "Id", "id")[:32],
                "name": _text(row, "Name", "name")[:128],
                "mode": _text(row, "Mode", "mode")[:64],
                "replicas": _text(row, "Replicas", "replicas")[:32],
                "image": _text(row, "Image", "image")[:255],
                "ports": _text(row, "Ports", "ports")[:255],
            }
        )
    return out
