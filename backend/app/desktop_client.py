"""Stamp server URL into the Windows desktop client template."""

from __future__ import annotations

import json
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_TEMPLATE = _PROJECT_ROOT / "agent" / "windows-client" / "prebuilt" / "Corax.template.exe"
_BEGIN = "<<<CORAX_CFG_BEGIN>>>".encode("utf-16le")
_END = "<<<CORAX_CFG_END>>>".encode("utf-16le")


def template_path() -> Path:
    return _TEMPLATE


def patch_utf16_config_slot(blob: bytes, config: dict) -> bytes:
    """Write JSON as UTF-16LE between the widest CORAX config markers.

    The WPF client stores the slot as a .NET string, so the bytes in the
    single-file EXE are UTF-16LE, not the ASCII slot of the C++ agent.
    """
    pairs: list[tuple[int, int]] = []
    start = 0
    while True:
        begin = blob.find(_BEGIN, start)
        if begin < 0:
            break
        end = blob.find(_END, begin + len(_BEGIN))
        if end < 0:
            break
        pairs.append((begin, end))
        start = begin + 2
    if not pairs:
        raise ValueError(
            "В Corax.template.exe нет слота <<<CORAX_CFG_BEGIN>>> (UTF-16). "
            "Соберите клиент по docs/windows-client.md и положите EXE в "
            "agent/windows-client/prebuilt/Corax.template.exe."
        )
    begin, end = max(pairs, key=lambda pair: pair[1] - pair[0])
    payload_start = begin + len(_BEGIN)
    capacity = end - payload_start
    raw = json.dumps(config, ensure_ascii=False).encode("utf-16le")
    if len(raw) > capacity:
        raise ValueError(f"Конфиг клиента не влезает в слот ({len(raw)} > {capacity} байт)")
    patched = bytearray(blob)
    patched[payload_start:end] = raw + (b"\x00" * (capacity - len(raw)))
    return bytes(patched)


def build_desktop_client_exe(server_url: str) -> tuple[bytes, str]:
    path = template_path()
    if not path.is_file():
        raise FileNotFoundError(
            "Нет шаблона agent/windows-client/prebuilt/Corax.template.exe. "
            "Соберите его на Windows: docs/windows-client.md"
        )
    server = server_url.strip().rstrip("/")
    if not server.lower().startswith(("http://", "https://")):
        raise ValueError("server_url должен начинаться с http:// или https://")
    data = patch_utf16_config_slot(path.read_bytes(), {"server_url": server})
    return data, "Corax.exe"
