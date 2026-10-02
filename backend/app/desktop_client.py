"""Stamp server URL into the Windows desktop client template."""

from __future__ import annotations

import json
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_TEMPLATE = _PROJECT_ROOT / "agent" / "windows-client" / "prebuilt" / "Corax.template.exe"
_BEGIN = "<<<CORAX_CFG_BEGIN>>>".encode("utf-16le")
_END = "<<<CORAX_CFG_END>>>".encode("utf-16le")
_TRAILER_MAGIC = b"CORAXCFG"


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


def stamp_config_trailer(blob: bytes, config: dict) -> bytes:
    """Append the server URL at the end of the EXE.

    The panel serves this file as the installer. A trailer stays readable
    even when the single-file bundle is compressed.
    """
    body = _strip_trailer(blob)
    raw = json.dumps(config, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > 8192:
        raise ValueError("Конфиг клиента не влезает в хвост EXE")
    return body + raw + len(raw).to_bytes(4, "little") + _TRAILER_MAGIC


def _strip_trailer(blob: bytes) -> bytes:
    if len(blob) < 12 or blob[-8:] != _TRAILER_MAGIC:
        return blob
    length = int.from_bytes(blob[-12:-8], "little")
    if length < 2 or length > 8192 or len(blob) < 12 + length:
        return blob
    return blob[: -(12 + length)]


def build_desktop_client_exe(server_url: str) -> tuple[bytes, str]:
    """Return the installer unchanged.

    The panel must not rewrite the EXE. The single-file host reads its
    bundle from the end of the file; a stamp there makes Windows run garbage.
    Server, port and token are typed in the installer on each PC.
    """
    path = template_path()
    if not path.is_file():
        raise FileNotFoundError(
            "На сервере нет установщика. Положите Corax.template.exe в "
            "agent/windows-client/prebuilt и пересоберите образ панели."
        )
    server = server_url.strip().rstrip("/")
    if server and not server.lower().startswith(("http://", "https://")):
        raise ValueError("server_url должен начинаться с http:// или https://")
    return path.read_bytes(), "Corax.exe"
