#!/usr/bin/env python3
"""Start llama-server from /etc/corax/llama-server.env. No shell.

The systemd unit should point ExecStart at this file. Unknown keys are ignored.
Values are checked again here so a hand-edited env file cannot become an argument.
"""
from __future__ import annotations

import os
import shutil
import sys

_ENV = "/etc/corax/llama-server.env"
_ROOTS = (
    "/models",
    "/opt/models",
    "/var/lib/corax/models",
    "/mnt/models",
    "/data/models",
)
_BINS = (
    "/usr/local/bin/llama-server",
    "/usr/bin/llama-server",
    "/opt/llama.cpp/build/bin/llama-server",
    "/opt/llama.cpp/llama-server",
)


def _read_env(path: str) -> dict[str, str]:
    if os.path.islink(path) or not os.path.isfile(path):
        return {}
    out: dict[str, str] = {}
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle.read(4000).splitlines():
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key in {"MODEL", "PORT", "LISTEN", "FLASH_ATTN", "METRICS", "NGL", "CTX", "THREADS", "RPC"}:
                out[key] = value.strip()
    return out


def _model(path: str) -> str | None:
    if not path.startswith("/") or not path.lower().endswith(".gguf"):
        return None
    if any(ch in path for ch in "\x00\n\r\t ;|&$`<>\"'\\") or ".." in path.split("/"):
        return None
    if not any(path == root or path.startswith(root + "/") for root in _ROOTS):
        return None
    return path


def _binary() -> str | None:
    for candidate in _BINS:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK) and not os.path.islink(candidate):
            return candidate
    found = shutil.which("llama-server")
    if found and os.path.basename(found) == "llama-server":
        return found
    return None


def main() -> int:
    env = _read_env(_ENV)
    model = _model(env.get("MODEL") or "")
    binary = _binary()
    if model is None or binary is None:
        sys.stderr.write("llama-server: нет MODEL в каталоге моделей или нет бинарника llama-server\n")
        return 1
    port = env.get("PORT") or "8080"
    listen = env.get("LISTEN") or "0.0.0.0"
    if not port.isdigit() or not 1024 <= int(port) <= 65535:
        return 1
    if listen not in {"0.0.0.0", "127.0.0.1"}:
        return 1
    argv = [binary, "--model", model, "--host", listen, "--port", port]
    if env.get("FLASH_ATTN") == "1":
        argv.extend(["--flash-attn", "on"])
    if "NGL" in env and env["NGL"].isdigit() and 0 <= int(env["NGL"]) <= 999:
        argv.extend(["-ngl", env["NGL"]])
    if "CTX" in env and env["CTX"].isdigit() and 256 <= int(env["CTX"]) <= 131072:
        argv.extend(["--ctx-size", env["CTX"]])
    if "THREADS" in env and env["THREADS"].isdigit() and 1 <= int(env["THREADS"]) <= 256:
        argv.extend(["-t", env["THREADS"]])
    rpc = env.get("RPC") or ""
    if rpc and all(ch not in rpc for ch in "\x00\n\r ;|&$`<>\"'\\") and len(rpc) <= 512:
        argv.extend(["--rpc", rpc])
    if env.get("METRICS") == "1":
        argv.append("--metrics")
    os.execv(binary, argv)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
