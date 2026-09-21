"""Windows 10/11 tray EXE bundle.

The EXE stays byte-identical so Authenticode / the installer checksum do not
break. The sealed token and server URL live in agent.json next to the EXE.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_bundle import _resolve_agent_token
from app.schemas import AgentBundleCreate

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_SEAL = b"corax.desktop.seal.v1\0"
_AAD = b"corax-agent"
_SEAL_BEGIN = b"<<<CORAX_DESKTOP_SEAL_BEGIN>>>"
_SEAL_END = b"<<<CORAX_DESKTOP_SEAL_END>>>"
_SEAL_SLOT = 2048
_SLOT_INNER = _SEAL_SLOT - len(_SEAL_BEGIN) - len(_SEAL_END)


def _desktop_exe_path() -> Path:
    for p in (
        _PROJECT_ROOT / "agent" / "desktop" / "prebuilt" / "CORAX-Agent.exe",
        _PROJECT_ROOT / "agent" / "desktop" / "bin" / "CORAX-Agent.exe",
    ):
        if p.is_file() and p.stat().st_size > 50_000:
            return p
    raise FileNotFoundError(
        "CORAX-Agent.exe ещё не собран. Положите его в agent/desktop/prebuilt/."
    )


def empty_seal_slot() -> bytes:
    inner = _SEAL_SLOT - len(_SEAL_BEGIN) - len(_SEAL_END)
    return _SEAL_BEGIN + (b" " * inner) + _SEAL_END


def seal_agent_token(token: str) -> dict:
    wrap = os.urandom(32)
    nonce = os.urandom(12)
    key = hashlib.sha256(_SEAL + wrap).digest()
    ct = AESGCM(key).encrypt(nonce, token.encode("utf-8"), _AAD)
    b64 = lambda raw: base64.b64encode(raw).decode("ascii")
    return {"v": 1, "wrap": b64(wrap), "nonce": b64(nonce), "ct": b64(ct)}


def unseal_agent_token(sealed: dict) -> str:
    wrap = base64.b64decode(sealed["wrap"])
    nonce = base64.b64decode(sealed["nonce"])
    ct = base64.b64decode(sealed["ct"])
    key = hashlib.sha256(_SEAL + wrap).digest()
    return AESGCM(key).decrypt(nonce, ct, _AAD).decode("utf-8")


def _pick_seal_span(exe_bytes: bytes) -> tuple[int, int]:
    """Use the padded 2 KiB slot, not a short/huge BEGIN..END pair from other strings."""
    pairs: list[tuple[int, int, int]] = []
    start = 0
    while True:
        begin = exe_bytes.find(_SEAL_BEGIN, start)
        if begin < 0:
            break
        end = exe_bytes.find(_SEAL_END, begin + len(_SEAL_BEGIN))
        if end < 0:
            start = begin + 1
            continue
        cap = end - (begin + len(_SEAL_BEGIN))
        if 256 <= cap <= 4096:
            pairs.append((abs(cap - _SLOT_INNER), begin, end))
        start = begin + 1
    if not pairs:
        raise ValueError(
            "В CORAX-Agent.exe нет слота токена (<<<CORAX_DESKTOP_SEAL_BEGIN>>>). "
            "Пересоберите EXE из agent/desktop."
        )
    pairs.sort()
    return pairs[0][1], pairs[0][2]


def stamp_desktop_exe(exe_bytes: bytes, sealed: dict) -> bytes:
    """Legacy PE-slot writer. New bundles never call this — it would break signatures."""
    begin, end = _pick_seal_span(exe_bytes)
    payload_start = begin + len(_SEAL_BEGIN)
    capacity = end - payload_start
    if capacity < 64:
        raise ValueError(f"Слот токена слишком мал ({capacity} байт).")
    raw = json.dumps(sealed, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(raw) > capacity:
        raise ValueError(f"Печать токена слишком большая ({len(raw)} > {capacity} байт)")
    patched = bytearray(exe_bytes)
    patched[payload_start:end] = raw + (b"\0" * (capacity - len(raw)))
    return bytes(patched)


def _install_bat() -> str:
    return (
        "@echo off\r\n"
        "setlocal EnableExtensions\r\n"
        "chcp 65001 >nul\r\n"
        "set \"SRC=%~dp0\"\r\n"
        "set \"DEST=%LOCALAPPDATA%\\CORAX\\desktop\"\r\n"
        "mkdir \"%DEST%\" 2>nul\r\n"
        "copy /Y \"%SRC%CORAX-Agent.exe\" \"%DEST%\\CORAX-Agent.exe\" >nul\r\n"
        "if errorlevel 1 (\r\n"
        "  echo Не удалось скопировать CORAX-Agent.exe\r\n"
        "  pause\r\n"
        "  exit /b 1\r\n"
        ")\r\n"
        "if exist \"%SRC%agent.json\" (\r\n"
        "  copy /Y \"%SRC%agent.json\" \"%DEST%\\agent.json\" >nul\r\n"
        "  if errorlevel 1 (\r\n"
        "    echo Не удалось скопировать agent.json — без токена отчёт не уйдёт.\r\n"
        "    pause\r\n"
        "    exit /b 1\r\n"
        "  )\r\n"
        ")\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\" /v \"CORAX Agent\" /t REG_SZ /d \"\\\"%DEST%\\CORAX-Agent.exe\\\"\" /f >nul\r\n"
        "start \"\" \"%DEST%\\CORAX-Agent.exe\"\r\n"
        "echo CORAX Agent установлен в %DEST%\r\n"
        "echo EXE не изменялся. Токен — в agent.json рядом.\r\n"
        "echo Агент сам соберёт инвентарь этого ПК.\r\n"
    )


def _readme() -> str:
    return (
        "CORAX Agent — Windows 10/11\r\n"
        "===========================\r\n"
        "\r\n"
        "1. Запустите Install.bat (или сразу CORAX-Agent.exe из этой папки).\r\n"
        "2. EXE не патчится: подпись и установщик не ломаются.\r\n"
        "3. Токен зашифрован в agent.json. URL сервера тоже, если сборка с панели.\r\n"
        "4. После установки агент сам собирает инвентарь и уходит в трей.\r\n"
        "5. Крестик прячет окно. Выход — из меню иконки.\r\n"
        "6. Отчёт раз в сутки (по умолчанию 09:00). Если ПК был выключен — при следующем старте.\r\n"
    )


def pack_desktop_zip(exe: Path, token: str, server_url: str = "") -> bytes:
    """Pack an unmodified EXE with a sidecar token. Never writes into the PE."""
    sealed = seal_agent_token(token)
    raw_exe = exe.read_bytes()
    secret = token.encode("utf-8")
    if secret in raw_exe:
        raise RuntimeError("plaintext token leaked into EXE template")
    prefix = token.split(".", 1)[0]
    agent_json: dict = {
        "token_enc": sealed,
        "token_prefix": prefix,
        "daily_at": "09:00",
        "autostart": True,
    }
    server = (server_url or "").strip().rstrip("/")
    if server:
        agent_json["server_url"] = server
    sidecar = (json.dumps(agent_json, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if secret in sidecar:
        raise RuntimeError("plaintext token leaked into agent.json")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("CORAX-Agent.exe", raw_exe)
        zf.writestr("agent.json", sidecar)
        zf.writestr("Install.bat", _install_bat())
        zf.writestr("README.txt", _readme())
    packed = buf.getvalue()
    if secret in packed:
        raise RuntimeError("plaintext token leaked into ZIP")
    return packed


async def build_desktop_bundle(db: AsyncSession, body: AgentBundleCreate) -> tuple[bytes, str]:
    token, _ = await _resolve_agent_token(db, body)
    server = body.server_url.strip().rstrip("/")
    if not server.lower().startswith(("http://", "https://")):
        raise ValueError("server_url должен начинаться с http:// или https://")
    exe = _desktop_exe_path()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    filename = f"corax-agent-desktop-{stamp}.zip"
    return pack_desktop_zip(exe, token, server), filename
