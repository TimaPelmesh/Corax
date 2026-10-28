#!/usr/bin/env python3
"""Run one allowlisted CORAX job from the audit directive and post the result.

The panel chooses the action. This process refuses anything that is not a
known action, a safe unit name, or a path inside the config directories.
It never calls a shell.
"""
from __future__ import annotations

import json
import os
import posixpath
import re
import sys
import urllib.error
import urllib.request

_UNIT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._@-]{0,80}$")
_TESTS = {"nginx": ["nginx", "-t"], "sshd": ["sshd", "-t"]}
_HOLD = {"systemd", "init", "dbus", "dbus-broker", "polkit", "polkitd"}
_SHELL = {"bash", "sh", "dash", "zsh", "python", "python3", "perl"}
_READ_FILES = {
    "/etc/hostname",
    "/etc/hosts",
    "/etc/os-release",
    "/etc/fstab",
    "/etc/resolv.conf",
    "/etc/nginx/nginx.conf",
    "/etc/ssh/sshd_config",
}
_SCRIPT_PREFIXES = (
    "/opt/corax/scripts/",
    "/var/lib/corax/scripts/",
)
_COMPOSE_PREFIXES = (
    "/etc/corax/compose/",
    "/opt/corax/compose/",
)
_READ_PREFIXES = (
    "/etc/nginx/",
    "/etc/apache2/",
    "/etc/httpd/",
    "/etc/ssh/sshd_config.d/",
    "/etc/corax/",
    *_SCRIPT_PREFIXES,
    *_COMPOSE_PREFIXES,
)
_WRITE_PREFIXES = (
    "/etc/nginx/conf.d/",
    "/etc/nginx/sites-available/",
    "/etc/apache2/sites-available/",
    "/etc/httpd/conf.d/",
    "/etc/corax/",
    *_SCRIPT_PREFIXES,
    *_COMPOSE_PREFIXES,
)
_CONTAINER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_DOCKER = {"ps", "start", "stop", "restart", "compose-up", "compose-down"}
_DENY_NAMES = {"shadow", "gshadow", "sudoers", "passwd", "group", "crontab", "authorized_keys"}
_DENY_BITS = ("sudoers", "cron.d", "crontab", "pam.d", "/systemd/", "id_rsa", ".pem", ".key")
_BODY_MAX = 32_768
_OUT_MAX = 65_536
_ENV_PATH = "/etc/corax/llama-server.env"
_MODEL_ROOTS = (
    "/models",
    "/opt/models",
    "/var/lib/corax/models",
    "/mnt/models",
    "/data/models",
)
_LLM_UNIT = re.compile(r"^(llama-server|rpc-server|rpc-server-gpu[0-7])$")
_RPC_HOST = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$")


def _unit(raw: str) -> str | None:
    name = (raw or "").strip()
    if not _UNIT.fullmatch(name):
        return None
    return name


def _base(name: str) -> str:
    return name[:-8] if name.endswith(".service") else name


def _controllable(name: str) -> bool:
    base = _base(name)
    return base not in _HOLD and base not in _SHELL


def _path(raw: str) -> str | None:
    text = (raw or "").strip()
    if not text.startswith("/") or "\x00" in text or "\\" in text:
        return None
    if any(part == ".." for part in text.split("/")):
        return None
    normal = posixpath.normpath(text)
    if normal != text.rstrip("/") or not normal.startswith("/"):
        return None
    lowered = normal.lower()
    parts = [part.lower() for part in normal.split("/") if part]
    if any(part in _DENY_NAMES for part in parts):
        return None
    if any(bit in lowered for bit in _DENY_BITS):
        return None
    return normal


def _under(path: str, prefixes: tuple[str, ...]) -> bool:
    for prefix in prefixes:
        root = prefix.rstrip("/")
        if path == root or path.startswith(root + "/"):
            return True
    return False


def _listable(path: str) -> bool:
    roots = tuple(root if root.endswith("/") else root + "/" for root in _MODEL_ROOTS)
    return _under(path, _READ_PREFIXES + roots)


def _readable(path: str) -> bool:
    name = posixpath.basename(path).lower()
    if name == ".env" or name.endswith(".env"):
        return False
    return path in _READ_FILES or any(path.startswith(prefix) for prefix in _READ_PREFIXES)


def _writable(path: str) -> bool:
    if path.endswith("/"):
        return False
    name = posixpath.basename(path).lower()
    if name == ".env" or name.endswith(".env"):
        return False
    return any(path.startswith(prefix) for prefix in _WRITE_PREFIXES)


def _run(argv: list[str], timeout: float = 25) -> tuple[int, str]:
    import subprocess

    if hasattr(os, "geteuid") and os.geteuid() != 0 and argv:
        tool = os.path.basename(argv[0])
        if tool in {"systemctl", "journalctl", "nginx", "sshd", "docker"} and argv[0] != "sudo":
            argv = ["sudo", "-n", *argv]
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "LC_ALL": "C"},
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)[:_OUT_MAX]
    text = ((proc.stdout or "") + (proc.stderr or ""))[:_OUT_MAX]
    return int(proc.returncode or 0), text


def _read(path: str) -> tuple[int, str]:
    if os.path.islink(path) or not os.path.isfile(path):
        return 1, "Файл не найден или это ссылка"
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return 0, fh.read(_OUT_MAX)
    except OSError as exc:
        return 1, str(exc)[:_OUT_MAX]


def _write(path: str, body: str) -> tuple[int, str]:
    if os.path.islink(path):
        return 1, "Путь — ссылка, запись отменена"
    parent = os.path.dirname(path)
    if os.path.islink(parent):
        return 1, "Каталог — ссылка, запись отменена"
    try:
        os.makedirs(parent, mode=0o755, exist_ok=True)
        tmp = path + ".corax.tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except OSError as exc:
        return 1, str(exc)[:_OUT_MAX]
    return 0, "Файл записан"


def _list_dir(path: str) -> tuple[int, str]:
    if os.path.islink(path) or not os.path.isdir(path):
        return 1, "Каталог не найден или это ссылка"
    try:
        entries = list(os.scandir(path))
    except OSError as exc:
        return 1, str(exc)[:_OUT_MAX]
    lines: list[str] = []
    entries.sort(key=lambda entry: (not entry.is_dir(follow_symlinks=False), entry.name.lower()))
    for entry in entries:
        if len(lines) >= 200:
            break
        name = entry.name
        if not name or name in {".", ".."} or "/" in name or "\n" in name or "\x00" in name:
            continue
        lowered = name.lower()
        if lowered == ".env" or lowered.endswith(".env") or lowered.endswith(".key") or lowered.endswith(".pem"):
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                kind = "d"
            elif entry.is_file(follow_symlinks=False):
                kind = "f"
            else:
                continue
        except OSError:
            continue
        lines.append(f"{kind} {name}")
    return 0, "\n".join(lines) if lines else "Пусто"


def _container(raw: object) -> str | None:
    name = raw.strip() if isinstance(raw, str) else ""
    if not _CONTAINER.fullmatch(name):
        return None
    return name


def _compose_file(directory: str) -> str | None:
    if os.path.islink(directory) or not os.path.isdir(directory):
        return None
    for name in ("compose.yml", "docker-compose.yml"):
        candidate = directory.rstrip("/") + "/" + name
        if os.path.islink(candidate) or not os.path.isfile(candidate):
            continue
        return candidate
    return None


def _docker(verb: str, body: object) -> tuple[int, str]:
    if verb == "ps":
        if body not in (None, ""):
            return 1, "Список контейнеров отклонён"
        return _run(["docker", "ps", "-a", "--format", "{{.Names}}|{{.Status}}|{{.Image}}"], timeout=20)
    if verb in {"start", "stop", "restart"}:
        name = _container(body)
        if name is None:
            return 1, "Имя контейнера отклонено"
        return _run(["docker", verb, name], timeout=40)
    if verb in {"compose-up", "compose-down"}:
        directory = _path(body if isinstance(body, str) else "")
        if directory is None or not _under(directory, _COMPOSE_PREFIXES):
            return 1, "Каталог compose отклонён"
        compose = _compose_file(directory)
        if compose is None:
            return 1, "В каталоге нет compose.yml"
        command = "up" if verb == "compose-up" else "down"
        argv = ["docker", "compose", "-f", compose, "--project-directory", directory, command]
        if command == "up":
            argv.append("-d")
        return _run(argv, timeout=120)
    return 1, "Команда Docker отклонена"


def _playbook(body: object) -> tuple[int, str]:
    if not isinstance(body, str) or not body.strip() or len(body) > _BODY_MAX or "\x00" in body:
        return 1, "Плейбук отклонён"
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return 1, "Плейбук отклонён"
    steps = data.get("steps") if isinstance(data, dict) else None
    if not isinstance(data, dict) or set(data) - {"steps"} or not isinstance(steps, list) or not 1 <= len(steps) <= 8:
        return 1, "Плейбук отклонён"
    chunks: list[str] = []
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict) or set(step) - {"action", "target", "body"}:
            return 1, "Плейбук отклонён"
        action = str(step.get("action") or "").strip().lower()
        if action == "playbook":
            return 1, "Плейбук отклонён"
        code, text = execute(
            {"action": action, "target": str(step.get("target") or ""), "body": step.get("body")}
        )
        chunks.append(f"--- {index} {action} {step.get('target') or ''} ({code}) ---\n{text.rstrip()}")
        if code != 0:
            return code, "\n".join(chunks)[:_OUT_MAX]
    return 0, "\n".join(chunks)[:_OUT_MAX]


def _llm_unit(raw: str) -> str | None:
    name = _unit(raw) or ""
    base = _base(name) if name else ""
    if not _LLM_UNIT.fullmatch(base):
        return None
    return base


def _model_path(raw: str) -> str | None:
    text = (raw or "").strip()
    if len(text) < 6 or len(text) > 240 or not text.startswith("/") or not text.lower().endswith(".gguf"):
        return None
    if any(ch in text for ch in "\x00\n\r\t ;|&$`<>\"'\\"):
        return None
    if any(part == ".." for part in text.split("/")):
        return None
    normal = posixpath.normpath(text)
    if normal != text:
        return None
    if not any(normal == root or normal.startswith(root + "/") for root in _MODEL_ROOTS):
        return None
    return normal


def _model_dir(raw: str) -> str | None:
    text = (raw or "").strip()
    if not text.startswith("/") or any(ch in text for ch in "\x00\n\r\t ;|&$`<>\"'\\"):
        return None
    if any(part == ".." for part in text.split("/")):
        return None
    normal = posixpath.normpath(text)
    if normal != text.rstrip("/") and normal != text:
        return None
    if not any(normal == root or normal.startswith(root + "/") for root in _MODEL_ROOTS):
        return None
    return normal


def _llama_spec(body: object) -> dict | None:
    if not isinstance(body, str) or not body.strip() or len(body) > 4000 or "\x00" in body:
        return None
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    allowed = {"model", "flash_attn", "ngl", "rpc", "metrics", "ctx", "port", "listen", "threads"}
    if set(data) - allowed:
        return None
    path = _model_path(str(data.get("model") or ""))
    if path is None:
        return None
    spec: dict = {"model": path, "metrics": True, "port": 8080, "listen": "0.0.0.0"}
    if "flash_attn" in data:
        if not isinstance(data["flash_attn"], bool):
            return None
        spec["flash_attn"] = data["flash_attn"]
    if "metrics" in data:
        if not isinstance(data["metrics"], bool):
            return None
        spec["metrics"] = data["metrics"]
    if data.get("ngl") is not None:
        try:
            ngl = int(data["ngl"])
        except (TypeError, ValueError):
            return None
        if ngl < 0 or ngl > 999:
            return None
        spec["ngl"] = ngl
    if data.get("ctx") is not None:
        try:
            ctx = int(data["ctx"])
        except (TypeError, ValueError):
            return None
        if ctx < 256 or ctx > 131072:
            return None
        spec["ctx"] = ctx
    if data.get("port") is not None:
        try:
            port = int(data["port"])
        except (TypeError, ValueError):
            return None
        if port < 1024 or port > 65535:
            return None
        spec["port"] = port
    if data.get("listen") not in (None, "", "0.0.0.0", "127.0.0.1"):
        return None
    if data.get("listen") in {"0.0.0.0", "127.0.0.1"}:
        spec["listen"] = data["listen"]
    if data.get("threads") is not None:
        try:
            threads = int(data["threads"])
        except (TypeError, ValueError):
            return None
        if threads < 1 or threads > 256:
            return None
        spec["threads"] = threads
    rpc = data.get("rpc")
    if rpc not in (None, ""):
        if not isinstance(rpc, str) or len(rpc) > 512 or any(ch in rpc for ch in "\x00\n\r ;|&$`<>\"'\\"):
            return None
        parts = [part for part in rpc.split(",") if part]
        if not parts or len(parts) > 8:
            return None
        for part in parts:
            if part.count(":") != 1:
                return None
            host, port_text = part.split(":", 1)
            if not port_text.isdigit() or not 1024 <= int(port_text) <= 65535 or not _RPC_HOST.fullmatch(host):
                return None
        spec["rpc"] = rpc
    return spec


def _apply_llama(spec: dict) -> tuple[int, str]:
    lines = [f"MODEL={spec['model']}", f"PORT={int(spec['port'])}", f"LISTEN={spec['listen']}"]
    if spec.get("flash_attn"):
        lines.append("FLASH_ATTN=1")
    if spec.get("metrics", True):
        lines.append("METRICS=1")
    if "ngl" in spec:
        lines.append(f"NGL={int(spec['ngl'])}")
    if "ctx" in spec:
        lines.append(f"CTX={int(spec['ctx'])}")
    if "threads" in spec:
        lines.append(f"THREADS={int(spec['threads'])}")
    if spec.get("rpc"):
        lines.append(f"RPC={spec['rpc']}")
    code, text = _write(_ENV_PATH, "\n".join(lines) + "\n")
    if code != 0:
        return code, text
    restart_code, restart_text = _run(["systemctl", "restart", "llama-server"], timeout=40)
    if restart_code != 0:
        return restart_code, restart_text or text
    return 0, "llama-server перезапущен с новым env"


def _list_models(target: str) -> tuple[int, str]:
    root = _model_dir(target)
    if root is None:
        return 1, "Каталог моделей отклонён"
    if os.path.islink(root) or not os.path.isdir(root):
        return 1, "Каталог моделей не найден"
    root_real = os.path.realpath(root)
    found: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel = os.path.relpath(dirpath, root)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        if depth > 3:
            dirnames[:] = []
            continue
        dirnames[:] = [name for name in dirnames if not name.startswith(".") and not os.path.islink(os.path.join(dirpath, name))]
        for name in sorted(filenames):
            if not name.lower().endswith(".gguf") or name.startswith("."):
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                continue
            real = os.path.realpath(full)
            if real != root_real and not real.startswith(root_real + os.sep):
                continue
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            found.append({"path": real, "size": int(size), "name": name[:180]})
            if len(found) >= 200:
                break
        if len(found) >= 200:
            break
    return 0, json.dumps({"models": found}, ensure_ascii=False)


def _port_open(port: int) -> bool:
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.4)
    try:
        return sock.connect_ex(("127.0.0.1", port)) == 0
    except OSError:
        return False
    finally:
        sock.close()


def _gpu_brief() -> list[dict]:
    import shutil

    binary = shutil.which("nvidia-smi")
    if not binary:
        return []
    code, text = _run(
        [
            binary,
            "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ],
        timeout=6,
    )
    if code != 0:
        return []
    rows = []
    for line in text.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 5:
            continue
        rows.append(
            {
                "index": parts[0][:8],
                "name": parts[1][:80],
                "util_percent": parts[2][:16],
                "mem_used_mb": parts[3][:16],
                "mem_total_mb": parts[4][:16],
                "temp_c": parts[5][:16] if len(parts) > 5 else None,
                "power_w": parts[6][:16] if len(parts) > 6 else None,
            }
        )
        if len(rows) >= 8:
            break
    return rows


def _rpc_probe(body: object) -> tuple[int, str]:
    ports = [50052, 50053]
    if isinstance(body, str) and body.strip():
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return 1, "Порты RPC отклонены"
        if not isinstance(data, dict) or set(data) - {"ports"} or not isinstance(data.get("ports"), list):
            return 1, "Порты RPC отклонены"
        parsed = []
        for port in data["ports"]:
            if isinstance(port, bool) or not isinstance(port, int) or port < 1024 or port > 65535:
                return 1, "Порты RPC отклонены"
            parsed.append(port)
            if len(parsed) > 8:
                return 1, "Порты RPC отклонены"
        if not parsed:
            return 1, "Порты RPC отклонены"
        ports = parsed
    report = {
        "ports": [{"port": port, "listening": _port_open(port)} for port in ports],
        "units": [],
        "gpus": _gpu_brief(),
    }
    names = ["llama-server", "rpc-server"] + [f"rpc-server-gpu{index}" for index in range(min(len(ports), 8))]
    for name in names:
        code, text = _run(["systemctl", "is-active", name], timeout=8)
        report["units"].append({"unit": name, "active": text.strip() == "active", "exit_code": code})
    return 0, json.dumps(report, ensure_ascii=False)


def execute(job: dict) -> tuple[int, str]:
    action = str(job.get("action") or "").strip().lower()
    target = str(job.get("target") or "")
    if action == "status":
        unit = _unit(target)
        if unit is None:
            return 1, "Имя службы отклонено"
        return _run(["systemctl", "status", unit, "--no-pager", "-n", "40"])
    if action == "test":
        unit = _unit(target)
        if unit is None or _base(unit) not in _TESTS:
            return 1, "Проверка отклонена"
        return _run(_TESTS[_base(unit)])
    if action == "units":
        if str(target or "").strip() not in {"", "service"} or job.get("body") not in (None, ""):
            return 1, "Список служб отклонён"
        return _run(
            ["systemctl", "list-units", "--type=service", "--all", "--no-pager", "--no-legend", "--plain"],
            timeout=20,
        )
    if action == "show":
        unit = _unit(target)
        if unit is None or not _controllable(unit):
            return 1, "Конфигурация отклонена"
        shown, show_text = _run(["systemctl", "show", unit, "--no-pager"], timeout=20)
        _cat, cat_text = _run(["systemctl", "cat", unit, "--no-pager"], timeout=20)
        text = show_text
        if cat_text.strip():
            text = f"{show_text.rstrip()}\n\n# unit file\n{cat_text}"
        return shown, text[:_OUT_MAX]
    if action == "restart":
        unit = _unit(target)
        if unit is None or not _controllable(unit):
            return 1, "Перезапуск отклонён"
        if job.get("body") not in (None, ""):
            return 1, "Перезапуск отклонён"
        return _run(["systemctl", "restart", unit], timeout=40)
    if action == "start" or action == "stop":
        unit = _llm_unit(target)
        if unit is None or job.get("body") not in (None, ""):
            return 1, "Управление отклонено"
        return _run(["systemctl", action, unit], timeout=40)
    if action == "journal":
        unit = _llm_unit(target)
        lines = 80
        raw_lines = job.get("body")
        if isinstance(raw_lines, str) and raw_lines.strip():
            if not raw_lines.strip().isdigit() or not 10 <= int(raw_lines.strip()) <= 200:
                return 1, "Журнал отклонён"
            lines = int(raw_lines.strip())
        if unit is None:
            return 1, "Журнал отклонён"
        return _run(["journalctl", "-u", unit, "-n", str(lines), "--no-pager", "-o", "short-iso"], timeout=20)
    if action == "llama-apply":
        if str(target or "").strip() not in {"", "llama-server", "llama-server.service"}:
            return 1, "Параметры отклонены"
        spec = _llama_spec(job.get("body"))
        if spec is None:
            return 1, "Параметры отклонены"
        return _apply_llama(spec)
    if action == "models":
        if job.get("body") not in (None, ""):
            return 1, "Каталог моделей отклонён"
        return _list_models(target)
    if action == "rpc-probe":
        if str(target or "").strip() not in {"", "rpc"}:
            return 1, "Проверка RPC отклонена"
        return _rpc_probe(job.get("body"))
    if action == "list":
        path = _path(target)
        if path is None or not _listable(path) or job.get("body") not in (None, ""):
            return 1, "Каталог отклонён"
        return _list_dir(path)
    if action == "docker":
        return _docker(str(target or "").strip().lower(), job.get("body"))
    if action == "playbook":
        if str(target or "").strip() not in {"", "run"}:
            return 1, "Плейбук отклонён"
        return _playbook(job.get("body"))
    if action == "read":
        path = _path(target)
        if path is None or not _readable(path):
            return 1, "Чтение отклонено"
        return _read(path)
    if action == "write":
        path = _path(target)
        body = job.get("body")
        if path is None or not _writable(path) or not isinstance(body, str) or len(body) > _BODY_MAX or "\x00" in body:
            return 1, "Запись отклонена"
        return _write(path, body)
    return 1, "Неизвестное действие"


def _post(origin: str, token: str, job_id: int, hostname: str, code: int, output: str) -> None:
    url = origin.rstrip("/") + "/api/v1/agent/audit-job"
    payload = json.dumps(
        {"id": job_id, "hostname": hostname, "exit_code": code, "output": output[:_OUT_MAX]},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            resp.read(1024)
    except urllib.error.URLError:
        return


def main() -> int:
    if len(sys.argv) < 2:
        return 0
    try:
        data = json.loads(open(sys.argv[1], encoding="utf-8").read())
    except (OSError, json.JSONDecodeError):
        return 0
    if not isinstance(data, dict):
        return 0
    jobs = data.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        return 0
    job = jobs[0]
    if not isinstance(job, dict) or not isinstance(job.get("id"), int):
        return 0
    token = (os.environ.get("AGENT_TOKEN") or "").strip()
    base = (os.environ.get("INVENTORY_SERVER") or "").strip().rstrip("/")
    hostname = str(data.get("hostname") or "").strip()
    if not token or not base or not hostname:
        return 0
    code, output = execute(job)
    _post(base, token, int(job["id"]), hostname, code, output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
