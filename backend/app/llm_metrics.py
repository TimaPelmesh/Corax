"""Parse llama-server Prometheus text and check LLM control parameters.

The agent is the only process that runs systemctl. These helpers decide
whether a job is even allowed to be queued. They do not open a shell.
"""

from __future__ import annotations

import json
import posixpath
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

MODEL_ROOTS = (
    "/models",
    "/opt/models",
    "/var/lib/corax/models",
    "/mnt/models",
    "/data/models",
)
LLM_ENV_PATH = "/etc/corax/llama-server.env"
_LLM_UNIT = re.compile(r"^(llama-server|rpc-server|rpc-server-gpu[0-7])$")
_METRIC_NAMES = {
    "prompt_tokens_seconds": "prompt_tokens_seconds",
    "predicted_tokens_seconds": "predicted_tokens_seconds",
    "tokens_predicted_total": "tokens_predicted_total",
    "prompt_tokens_total": "prompt_tokens_total",
}
_SAMPLE = re.compile(r"^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{[^}]*\})?\s+([-+0-9.eE]+)\s*$")
_OFFLOAD = re.compile(r"offloaded\s+(\d+)\s*/\s*(\d+)\s+layers", re.IGNORECASE)
_OFFLOADING = re.compile(r"offloading\s+(\d+)\s+repeating\s+layers", re.IGNORECASE)
_N_LAYER = re.compile(r"n_layer\s*[=:]\s*(\d+)", re.IGNORECASE)
_APPLY_FIELDS = frozenset(
    {"model", "flash_attn", "ngl", "rpc", "metrics", "ctx", "port", "listen", "threads"}
)
_HOST = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$")
_BLOCKED_URL_HOSTS = frozenset(
    {
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
        "metadata.google.internal",
        "169.254.169.254",
    }
)


def llm_unit_base(name: str | None) -> str | None:
    text = (name or "").strip()
    if text.endswith(".service"):
        text = text[:-8]
    if not _LLM_UNIT.fullmatch(text):
        return None
    return text


def model_path_allowed(raw: str | None) -> str | None:
    text = (raw or "").strip()
    if len(text) < 6 or len(text) > 240:
        return None
    if not text.startswith("/") or not text.lower().endswith(".gguf"):
        return None
    if any(ch in text for ch in "\x00\n\r\t ;|&$`<>\"'\\"):
        return None
    if any(part == ".." for part in text.split("/")):
        return None
    normal = posixpath.normpath(text)
    if normal != text:
        return None
    if not any(normal == root or normal.startswith(root + "/") for root in MODEL_ROOTS):
        return None
    return normal


def model_dir_allowed(raw: str | None) -> str | None:
    text = (raw or "").strip() or "/models"
    if not text.startswith("/") or any(ch in text for ch in "\x00\n\r\t ;|&$`<>\"'\\"):
        return None
    if any(part == ".." for part in text.split("/")):
        return None
    normal = posixpath.normpath(text)
    if normal != text.rstrip("/") and normal != text:
        return None
    if not any(normal == root or normal.startswith(root + "/") for root in MODEL_ROOTS):
        return None
    return normal


def parse_rpc_ports(raw: str | None, default: tuple[int, ...] = (50052, 50053)) -> list[int]:
    text = (raw or "").strip()
    if not text:
        return list(default)
    ports: list[int] = []
    for part in text.split(","):
        piece = part.strip()
        if not piece.isdigit():
            return []
        port = int(piece)
        if port < 1024 or port > 65535 or port in ports:
            return []
        ports.append(port)
        if len(ports) > 8:
            return []
    return ports


def parse_llamacpp_metrics(text: str) -> dict[str, float]:
    """Pick the four llama-server series. Totals are summed; speeds keep the max."""
    found: dict[str, list[float]] = {}
    for line in (text or "").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        match = _SAMPLE.match(raw)
        if match is None:
            continue
        key = _metric_key(match.group(1))
        if key is None:
            continue
        try:
            value = float(match.group(2))
        except ValueError:
            continue
        if value != value or value < 0 or value > 1e18:
            continue
        found.setdefault(key, []).append(value)
    out: dict[str, float] = {}
    for key, values in found.items():
        if key.endswith("_total"):
            out[key] = float(sum(values))
        else:
            out[key] = float(max(values))
    return out


def _metric_key(name: str) -> str | None:
    rest = ""
    if name.startswith("llamacpp:"):
        rest = name[len("llamacpp:") :]
    elif name.startswith("llamacpp_"):
        rest = name[len("llamacpp_") :]
    else:
        return None
    if rest.endswith(("_sum", "_count", "_bucket", "_created")):
        return None
    return _METRIC_NAMES.get(rest)


def derive_layers(journal: str | None, config: dict | None) -> dict[str, Any]:
    """Layer counts llama-server does not export as metrics.

    Journal offload lines are measured. `-ngl` is only the requested local count.
    """
    text = journal or ""
    offload = _OFFLOAD.search(text)
    if offload is not None:
        local = int(offload.group(1))
        total = int(offload.group(2))
        return {
            "local_layers": local,
            "remote_layers": max(0, total - local),
            "total_layers": total,
            "source": "journal",
            "detail": offload.group(0)[:180],
        }
    repeating = _OFFLOADING.search(text)
    if repeating is not None:
        local = int(repeating.group(1))
        total_match = _N_LAYER.search(text)
        total = int(total_match.group(1)) if total_match else None
        remote = max(0, total - local) if total is not None else None
        return {
            "local_layers": local,
            "remote_layers": remote,
            "total_layers": total,
            "source": "journal",
            "detail": repeating.group(0)[:180],
        }
    ngl = _ngl(config)
    if ngl is not None:
        return {
            "local_layers": ngl,
            "remote_layers": None,
            "total_layers": None,
            "source": "config",
            "detail": "requested -ngl; llama-server does not publish per-GPU layer counts",
        }
    return {
        "local_layers": None,
        "remote_layers": None,
        "total_layers": None,
        "source": "unknown",
        "detail": "",
    }


def _ngl(config: dict | None) -> int | None:
    if not isinstance(config, dict) or "ngl" not in config or config["ngl"] is None:
        return None
    try:
        value = int(config["ngl"])
    except (TypeError, ValueError):
        return None
    if value < 0 or value > 999:
        return None
    return value


def parse_llama_apply(body: str | None) -> tuple[dict[str, Any] | None, str | None]:
    if body is None or not str(body).strip():
        return None, "Нет параметров llama-server"
    if len(body) > 4000 or "\x00" in body:
        return None, "Параметры слишком длинные"
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None, "Параметры должны быть JSON"
    if not isinstance(data, dict):
        return None, "Параметры должны быть объектом"
    if set(data) - _APPLY_FIELDS:
        return None, "Неизвестные параметры llama-server"
    path = model_path_allowed(str(data.get("model") or ""))
    if path is None:
        return None, "Модель должна быть .gguf внутри каталога моделей"
    spec: dict[str, Any] = {"model": path}
    if "flash_attn" in data:
        if not isinstance(data["flash_attn"], bool):
            return None, "flash-attn должен быть да или нет"
        spec["flash_attn"] = data["flash_attn"]
    if "metrics" in data:
        if not isinstance(data["metrics"], bool):
            return None, "metrics должен быть да или нет"
        spec["metrics"] = data["metrics"]
    else:
        spec["metrics"] = True
    if "ngl" in data and data["ngl"] is not None:
        ngl = _ngl({"ngl": data["ngl"]})
        if ngl is None:
            return None, "ngl: целое от 0 до 999"
        spec["ngl"] = ngl
    if "ctx" in data and data["ctx"] is not None:
        try:
            ctx = int(data["ctx"])
        except (TypeError, ValueError):
            return None, "ctx: целое от 256 до 131072"
        if ctx < 256 or ctx > 131072:
            return None, "ctx: целое от 256 до 131072"
        spec["ctx"] = ctx
    if "port" in data and data["port"] is not None:
        try:
            port = int(data["port"])
        except (TypeError, ValueError):
            return None, "Порт llama-server: 1024–65535"
        if port < 1024 or port > 65535:
            return None, "Порт llama-server: 1024–65535"
        spec["port"] = port
    else:
        spec["port"] = 8080
    if "listen" in data and data["listen"] not in (None, ""):
        listen = str(data["listen"]).strip()
        if listen not in {"0.0.0.0", "127.0.0.1"}:
            return None, "Слушать можно только 0.0.0.0 или 127.0.0.1"
        spec["listen"] = listen
    else:
        spec["listen"] = "0.0.0.0"
    if "threads" in data and data["threads"] is not None:
        try:
            threads = int(data["threads"])
        except (TypeError, ValueError):
            return None, "threads: целое от 1 до 256"
        if threads < 1 or threads > 256:
            return None, "threads: целое от 1 до 256"
        spec["threads"] = threads
    if "rpc" in data and data["rpc"] not in (None, ""):
        rpc = _rpc_list(str(data["rpc"]))
        if rpc is None:
            return None, "rpc: список host:port через запятую"
        spec["rpc"] = rpc
    return spec, None


def _rpc_list(raw: str) -> str | None:
    text = raw.strip()
    if len(text) > 512 or any(ch in text for ch in "\x00\n\r ;|&$`<>\"'\\"):
        return None
    parts = [part.strip() for part in text.split(",") if part.strip()]
    if not parts or len(parts) > 8:
        return None
    cleaned: list[str] = []
    for part in parts:
        if part.count(":") != 1:
            return None
        host, port_text = part.split(":", 1)
        if not port_text.isdigit():
            return None
        port = int(port_text)
        if port < 1024 or port > 65535:
            return None
        if not _HOST.fullmatch(host) or host.lower() in _BLOCKED_URL_HOSTS:
            return None
        cleaned.append(f"{host}:{port}")
    return ",".join(cleaned)


def explain_llm_job(action: str, target: str, body: str | None) -> str | None:
    """None when this LLM job may be queued."""
    kind = (action or "").strip().lower()
    if kind in {"start", "stop"}:
        if llm_unit_base(target) is None:
            return "Запускать и останавливать можно только llama-server и rpc-server-gpuN"
        if body not in (None, ""):
            return "У start и stop нет дополнительных аргументов"
        return None
    if kind == "journal":
        if llm_unit_base(target) is None:
            return "Журнал можно читать только у llama-server и rpc-server"
        if body not in (None, ""):
            text = str(body).strip()
            if not text.isdigit() or not 10 <= int(text) <= 200:
                return "Столько строк журнала читать нельзя"
        return None
    if kind == "llama-apply":
        if (target or "").strip() not in {"", "llama-server", "llama-server.service"}:
            return "Параметры применяются только к llama-server"
        _spec, reason = parse_llama_apply(body)
        return reason
    if kind == "models":
        if model_dir_allowed(target) is None:
            return "Каталог моделей вне списка разрешённых"
        if body not in (None, ""):
            return "Список моделей не принимает тело запроса"
        return None
    if kind == "rpc-probe":
        if (target or "").strip() not in {"", "rpc"}:
            return "Проверка RPC отклонена"
        return _explain_ports(body)
    return "Неизвестное действие"


def _explain_ports(body: str | None) -> str | None:
    if body in (None, ""):
        return None
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return "Порты RPC должны быть JSON"
    if not isinstance(data, dict) or set(data) - {"ports"}:
        return "Проверка RPC принимает только список портов"
    ports = data.get("ports")
    if not isinstance(ports, list) or not ports or len(ports) > 8:
        return "Нужно от 1 до 8 портов RPC"
    for port in ports:
        if isinstance(port, bool) or not isinstance(port, int) or port < 1024 or port > 65535:
            return "Порт RPC вне диапазона 1024–65535"
    return None


def gpu_rows_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("gpus")
    if not isinstance(rows, list):
        return []
    out: list[dict[str, Any]] = []
    for row in rows[:8]:
        if not isinstance(row, dict):
            continue
        try:
            index = int(row.get("index") or 0)
        except (TypeError, ValueError):
            index = len(out)
        if index < 0 or index > 16:
            continue
        out.append(
            {
                "gpu_index": index,
                "name": str(row.get("name") or f"GPU {index}")[:80],
                "util_percent": _bounded(row.get("util_percent"), 0, 100),
                "mem_used_mb": _bounded(row.get("mem_used_mb"), 0, 1_000_000),
                "mem_total_mb": _bounded(row.get("mem_total_mb"), 0, 1_000_000),
                "temp_c": _bounded(row.get("temp_c"), 1, 125),
                "power_w": _bounded(row.get("power_w"), 0, 2000),
            }
        )
    return out


def _bounded(value: Any, lo: float, hi: float) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number < lo or number > hi:
        return None
    return number


def service_url(raw: str | None, *, hostname: str, ip: str | None, kind: str) -> str | None:
    """http(s) URL whose host is this audit node, not the API machine and not metadata."""
    text = (raw or "").strip()
    if not text or len(text) > 300 or any(ch in text for ch in "\x00\n\r\t "):
        return None
    parts = urlsplit(text)
    if parts.scheme not in {"http", "https"} or parts.username or parts.password:
        return None
    host = (parts.hostname or "").strip().lower().rstrip(".")
    if not host or host in _BLOCKED_URL_HOSTS or host.endswith(".local"):
        return None
    allowed = {(hostname or "").strip().lower().rstrip(".")}
    if ip:
        allowed.add(ip.strip().lower())
    allowed.discard("")
    if host not in allowed:
        return None
    try:
        port = parts.port
    except ValueError:
        return None
    if port is not None and (port < 1 or port > 65535):
        return None
    path = parts.path or ""
    if kind == "metrics":
        if path in {"", "/"}:
            path = "/metrics"
        if path != "/metrics" or parts.query or parts.fragment:
            return None
    elif kind == "chat":
        if path not in {"", "/"} or parts.query or parts.fragment:
            return None
        path = ""
    else:
        return None
    port_bit = f":{port}" if port else ""
    return f"{parts.scheme}://{host}{port_bit}{path}"


def build_health(nodes: list[dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
    """Shape the panel and probes share. `status` is ok, degraded, or down."""
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    central = next((node for node in nodes if node.get("role") == "central"), None)
    if central is None and nodes:
        central = nodes[0]
    rpc_rows: list[dict[str, Any]] = []
    for node in nodes:
        for row in node.get("rpc") or []:
            if not isinstance(row, dict):
                continue
            rpc_rows.append(
                {
                    "hostname": node.get("hostname"),
                    "role": node.get("role"),
                    "unit": row.get("unit"),
                    "port": row.get("port"),
                    "listening": row.get("listening"),
                    "active": row.get("active"),
                    "vram_total_mb": row.get("vram_total_mb"),
                    "vram_used_mb": row.get("vram_used_mb"),
                }
            )
    if central is None:
        return {
            "status": "down",
            "checked_at": moment.isoformat(),
            "llama": {
                "configured": False,
                "reachable": False,
                "metrics_age_sec": None,
                "model": None,
                "detail": "no central node",
            },
            "rpc": rpc_rows,
        }
    age = central.get("metrics_age_sec")
    configured = bool(central.get("metrics_configured"))
    fresh = isinstance(age, (int, float)) and age >= 0 and age <= 90 and bool(central.get("metrics_ok"))
    llama = {
        "configured": configured,
        "reachable": fresh,
        "metrics_age_sec": age if isinstance(age, (int, float)) else None,
        "model": central.get("model"),
        "detail": None if fresh else ("metrics not configured" if not configured else "metrics stale or scrape failed"),
    }
    rpc_bad = any(row.get("listening") is False or row.get("active") is False for row in rpc_rows)
    if not configured or not fresh:
        status = "degraded" if nodes else "down"
        if not configured and not rpc_rows:
            status = "down"
    elif rpc_bad:
        status = "degraded"
    else:
        status = "ok"
    return {"status": status, "checked_at": moment.isoformat(), "llama": llama, "rpc": rpc_rows}
