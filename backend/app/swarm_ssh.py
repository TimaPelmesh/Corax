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
_ROLE = frozenset({"manager", "worker"})
_ADVERTISE = re.compile(
    r"^(?:"
    r"(?:\d{1,3}\.){3}\d{1,3}"
    r"|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)"
    r"(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*"
    r")$"
)
_JOIN_TOKEN = re.compile(r"^SWMTKN-1-[A-Za-z0-9-]{16,220}$")
_MANAGER_ADDR = re.compile(
    r"^(?:"
    r"(?:\d{1,3}\.){3}\d{1,3}"
    r"|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)"
    r"(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*"
    r"):2377$"
)

_INFO = "docker info --format '{{.Swarm.LocalNodeState}}|{{.Swarm.ControlAvailable}}'"
_NODE_SELF = (
    "docker info --format "
    "'{{.Name}}|{{.Swarm.LocalNodeState}}|{{.Swarm.ControlAvailable}}|{{.Swarm.NodeID}}'"
)
_NODES = "docker node ls --format '{{json .}}'"
_SERVICES = "docker service ls --format '{{json .}}'"
_UNAME = "uname -s"
_OS_RELEASE = "cat /etc/os-release"
# Fixed systemd units for Linux Swarm nodes (never Asterion / Windows).
_ENSURE_UNITS = ("containerd", "docker", "corax-audit")


def service_name(raw: str) -> str:
    name = (raw or "").strip()
    if not _SERVICE.fullmatch(name) or ".." in name:
        raise ValueError("Некорректное имя службы Swarm")
    return name


def replica_count(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > _MAX_REPLICAS:
        raise ValueError(f"Число реплик от 0 до {_MAX_REPLICAS}")
    return value


def swarm_role(raw: str) -> str:
    role = (raw or "").strip().lower()
    if role not in _ROLE:
        raise ValueError("Роль узла: manager или worker")
    return role


def advertise_addr(raw: str | None) -> str | None:
    value = (raw or "").strip()
    if not value:
        return None
    if not _ADVERTISE.fullmatch(value) or ".." in value:
        raise ValueError("Некорректный advertise-addr")
    if value.count(".") == 3 and all(part.isdigit() for part in value.split(".")):
        parts = [int(part) for part in value.split(".")]
        if any(part > 255 for part in parts):
            raise ValueError("Некорректный advertise-addr")
    return value


def join_token(raw: str) -> str:
    token = (raw or "").strip()
    if not _JOIN_TOKEN.fullmatch(token):
        raise ValueError("Некорректный токен join Swarm")
    return token


def manager_listen_addr(raw: str) -> str:
    value = (raw or "").strip()
    if "://" in value:
        raise ValueError("Адрес менеджера: host:2377 без схемы")
    if ":" not in value:
        value = f"{value}:2377"
    if not _MANAGER_ADDR.fullmatch(value) or ".." in value:
        raise ValueError("Адрес менеджера: host:2377")
    host, _, port = value.rpartition(":")
    if port != "2377":
        raise ValueError("Порт Swarm join только 2377")
    if host.count(".") == 3 and all(part.isdigit() for part in host.split(".")):
        parts = [int(part) for part in host.split(".")]
        if any(part > 255 for part in parts):
            raise ValueError("Адрес менеджера: host:2377")
    return value


def overview_commands() -> list[tuple[str, float]]:
    return [(_INFO, 20), (_NODES, 25), (_SERVICES, 25)]


def probe_commands() -> list[tuple[str, float]]:
    return [(_NODE_SELF, 20)]


def detect_os_commands() -> list[tuple[str, float]]:
    """uname + os-release — gate Linux Swarm automation (refuse Asterion)."""
    return [(_UNAME, 10), (_OS_RELEASE, 10)]


def ensure_services_commands() -> list[tuple[str, float]]:
    """Enable and start fixed units needed for Docker Swarm on Linux.

    Order: containerd → docker → corax-audit (optional if unit missing).
    Caller should use stop_on_error=False so a missing optional unit does not
    abort docker bring-up; then verify with probe_commands().
    """
    out: list[tuple[str, float]] = []
    for unit in _ENSURE_UNITS:
        quoted = shlex.quote(unit)
        out.append((f"systemctl enable {quoted}", 25))
        out.append((f"systemctl start {quoted}", 60))
    out.append(("systemctl is-active docker", 15))
    return out


def parse_pretty_name(os_release: str) -> str:
    pretty = ""
    name = ""
    for raw in (os_release or "").splitlines():
        line = raw.strip()
        if line.startswith("PRETTY_NAME="):
            pretty = line.split("=", 1)[1].strip().strip('"').strip("'")
        elif line.startswith("NAME=") and not name:
            name = line.split("=", 1)[1].strip().strip('"').strip("'")
    return (pretty or name or "").strip()[:128]


def assert_linux_swarm_host(uname: str, os_release: str) -> str:
    """Accept only Linux hosts that are not Asterion. Returns pretty OS name."""
    system = ""
    for raw in (uname or "").splitlines():
        line = raw.strip()
        if line:
            system = line
    if system.lower() != "linux":
        raise ValueError(
            f"Автозапуск Swarm-служб только на Linux (uname={system or '?'}). "
            "Windows / Asterion сюда не подходят."
        )
    blob = f"{uname}\n{os_release}".lower()
    if "asterion" in blob:
        raise ValueError(
            "Узел Asterion: автозапуск Docker Swarm служб через Corax отключён. "
            "Используйте Linux-сервер с Docker Engine."
        )
    # Windows-like guests sometimes leak into os-release text
    if any(token in blob for token in ("mingw", "cygwin", "msys", "windows_nt", "windows nt")):
        raise ValueError("Автозапуск Swarm-служб только на Linux, не на Windows.")
    return parse_pretty_name(os_release) or "Linux"


def looks_like_docker_daemon_down(text: str) -> bool:
    low = (text or "").lower()
    return (
        "cannot connect to the docker daemon" in low
        or "is the docker daemon running" in low
        or ("permission denied" in low and "docker.sock" in low)
        or ("connect: no such file or directory" in low and "docker" in low)
    )


def init_commands(addr: str | None = None) -> list[tuple[str, float]]:
    if addr:
        target = shlex.quote(advertise_addr(addr) or "")
        return [(f"docker swarm init --advertise-addr {target}", 45), (_NODE_SELF, 20)]
    return [("docker swarm init", 45), (_NODE_SELF, 20)]


def join_token_commands(role: str) -> list[tuple[str, float]]:
    kind = swarm_role(role)
    return [(f"docker swarm join-token {kind} -q", 20)]


def join_commands(token: str, manager_addr: str) -> list[tuple[str, float]]:
    tok = shlex.quote(join_token(token))
    addr = shlex.quote(manager_listen_addr(manager_addr))
    return [(f"docker swarm join --token {tok} {addr}", 60), (_NODE_SELF, 20)]


def leave_commands(*, force: bool = False) -> list[tuple[str, float]]:
    if force:
        return [("docker swarm leave --force", 30), (_NODE_SELF, 20)]
    return [("docker swarm leave", 30), (_NODE_SELF, 20)]


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


_TEMPLATE_JUNK = re.compile(r"^(?:\|?(?:true|false)?\|?)+\s*$", re.IGNORECASE)


def humanize_docker_error(raw: str, fallback: str = "Команда docker на сервере не выполнилась") -> str:
    """Turn docker CLI / template leftovers into a short operator-facing message."""
    text = (raw or "").replace("\r", "\n").strip()
    if not text:
        return fallback
    lines = [line.strip() for line in text.splitlines() if line.strip() and not _TEMPLATE_JUNK.fullmatch(line.strip())]
    cleaned = "\n".join(lines).strip() or text
    low = cleaned.lower()
    if "cannot connect to the docker daemon" in low or "is the docker daemon running" in low:
        return (
            "На сервере не запущен Docker daemon (нет связи с /var/run/docker.sock). "
            "На Linux Corax может поднять службы кнопкой «Запустить службы» "
            "(systemctl enable/start docker + containerd). "
            "Проверьте, что пакет docker установлен и SSH-пользователь в группе docker или root."
        )
    if "permission denied" in low and "docker.sock" in low:
        return "Нет доступа к docker.sock — добавьте SSH-пользователя в группу docker или зайдите как root."
    if "docker: command not found" in low or "not found" in low and "docker" in low:
        return "На сервере нет команды docker — установите Docker Engine."
    if "this node is not a swarm manager" in low:
        return "Этот узел не менеджер Swarm — действия кластера делайте с менеджера."
    if "this node is already part of a swarm" in low:
        return "Узел уже в Swarm."
    if "this node is not part of a swarm" in low:
        return "Узел не состоит в Swarm."
    return cleaned[:500]


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
