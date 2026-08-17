"""Build CORAX Agent v3 ZIP bundles for deployment."""

from __future__ import annotations

import io
import json
import secrets
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import hashlib
import hmac

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import AgentToken
from app.schemas import AgentBundleCreate, AgentBundleModules, AgentBundleSchedule

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_AGENT_WIN10_TEMPLATE = _PROJECT_ROOT / "agent" / "v3" / "win10"
_AGENT_WIN7_TEMPLATE = _PROJECT_ROOT / "agent" / "win7"
_AGENT_LINUX_TEMPLATE = _PROJECT_ROOT / "agent" / "linux"
_AGENT_WINDOWS_WRAPPER = _PROJECT_ROOT / "agent" / "windows"

_AGENT_TOKEN_PREFIX = "hmac256:"

_PROFILE_MODULES: dict[str, dict[str, bool]] = {
    "basic": {
        "patches": False,
        "network": False,
        "domain_sessions": False,
        "bitlocker": False,
        "tpm_secureboot": False,
        "antivirus": False,
        "startup": False,
        "services": False,
        "storage_health": False,
        "battery": False,
        "windows_features": False,
        "office": False,
        "usb_history": False,
        "docker_wsl": False,
    },
    "standard": {
        "patches": True,
        "network": True,
        "domain_sessions": True,
        "bitlocker": False,
        "tpm_secureboot": True,
        "antivirus": True,
        "startup": True,
        "services": False,
        "storage_health": True,
        "battery": True,
        "windows_features": False,
        "office": True,
        "usb_history": False,
        "docker_wsl": True,
    },
    "full": {
        "patches": True,
        "network": True,
        "domain_sessions": True,
        "bitlocker": True,
        "tpm_secureboot": True,
        "antivirus": True,
        "startup": True,
        "services": True,
        "storage_health": True,
        "battery": True,
        "windows_features": True,
        "office": True,
        "usb_history": True,
        "docker_wsl": True,
    },
}

# Files generated at bundle time — skip from template copy
_GENERATED_NAMES = frozenset({"agent_env.bat", "agent_env.sh", "agent_config.json"})

# Example / local-only files not shipped in bundle
_SKIP_NAMES = frozenset(
    {
        "agent_env.bat.example",
        "agent_env.sh.example",
        "agent_config.json.example",
    }
)

# Nested copies of these would register the wrong bat / duplicate docs.
_NESTED_SKIP_NAMES = frozenset(
    {
        "register_scheduled_task.ps1",
        "README_DEPLOY.txt",
        "install_schedule.bat",
    }
)


def _hmac_secret(secret: str) -> str:
    key = (settings.agent_token_pepper or settings.secret_key).encode("utf-8")
    return hmac.new(key, secret.encode("utf-8"), hashlib.sha256).hexdigest()


async def _resolve_agent_token(db: AsyncSession, body: AgentBundleCreate) -> tuple[str, bool]:
    """Return (token, created_new)."""
    if not body.create_token:
        token = (body.existing_token or settings.agent_token or "").strip()
        if not token:
            raise ValueError("Укажите existing_token или включите create_token")
        return token, False

    if (body.existing_token or "").strip():
        return body.existing_token.strip(), False  # type: ignore[union-attr]

    public_id = secrets.token_hex(4)
    secret = secrets.token_urlsafe(24)
    token = f"{public_id}.{secret}"
    row = AgentToken(
        public_id_prefix=public_id,
        token_hash=_AGENT_TOKEN_PREFIX + _hmac_secret(secret),
        label=body.token_label or f"bundle {datetime.now(timezone.utc):%Y-%m-%d}",
        allowed_hostname=(body.allowed_hostname or "").strip() or None,
    )
    db.add(row)
    await db.commit()
    return token, True


def _resolve_modules(body: AgentBundleCreate) -> dict[str, bool]:
    if body.profile == "custom" and body.modules is not None:
        return body.modules.model_dump()
    preset = _PROFILE_MODULES.get(body.profile) or _PROFILE_MODULES["full"]
    if body.profile != "custom" and body.modules is not None:
        merged = dict(preset)
        merged.update(body.modules.model_dump())
        return merged
    return dict(preset)


def _build_agent_config(body: AgentBundleCreate) -> dict:
    schedule = body.schedule or AgentBundleSchedule()
    profile_key = "custom" if body.profile == "custom" else "full"
    return {
        "agent_version": "3.0.1",
        "profile": profile_key,
        "modules": _resolve_modules(body),
        "limits": {
            "software_max": 12000,
            "services_max": 400,
            "patches_max": 500,
            "usb_max": 200,
        },
        "schedule": {
            "enabled": schedule.enabled,
            "mode": schedule.mode,
            "time": schedule.time,
            "weekday": schedule.weekday,
            "task_name": schedule.task_name,
        },
    }


def _write_agent_env_sh(server_url: str, agent_token: str) -> str:
    return (
        "#!/bin/sh\n"
        "# Auto-generated by CORAX admin panel — do not commit secrets.\n"
        f'export INVENTORY_SERVER="{server_url.rstrip("/")}"\n'
        f'export AGENT_TOKEN="{agent_token}"\n'
    )


def _build_linux_zip(body: AgentBundleCreate, server: str, token: str) -> tuple[bytes, str]:
    profile_key = "custom" if body.profile == "custom" else "full"
    config = _build_agent_config(body)
    config["agent_version"] = "3.1.1-linux"
    # Windows-only modules stay off by default on Linux profiles unless custom
    if body.profile != "custom":
        mods = config.get("modules") or {}
        for k in ("bitlocker", "windows_features", "office", "usb_history", "antivirus"):
            mods[k] = False
        config["modules"] = mods
    env_sh = _write_agent_env_sh(server, token)
    config_json = json.dumps(config, ensure_ascii=False, indent=2)
    schedule = body.schedule or AgentBundleSchedule()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"corax-agent-linux-{profile_key}-{stamp}.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for fs_path, arc_name in _iter_template_files(_AGENT_LINUX_TEMPLATE):
            data = fs_path.read_bytes()
            # Normalize shell scripts to LF
            if fs_path.suffix in {".sh", ".service", ".timer"} or fs_path.name in {
                "inventory_agent.sh",
                "corax_send.sh",
                "run_console.sh",
                "install_cron.sh",
                "update_scripts.sh",
            }:
                data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
            # Mark shell entrypoints executable inside the ZIP
            if arc_name.endswith(".sh") or arc_name in {
                "inventory_agent.sh",
                "corax_send.sh",
                "run_console.sh",
                "install_cron.sh",
                "update_scripts.sh",
            }:
                info = zipfile.ZipInfo(arc_name)
                info.date_time = time.localtime(fs_path.stat().st_mtime)[:6]
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o755 << 16
                zf.writestr(info, data)
            else:
                zf.writestr(arc_name, data)
        zf.writestr("agent_env.sh", env_sh.encode("utf-8"))
        zf.writestr("agent_config.json", config_json.encode("utf-8"))
        if schedule.enabled:
            # cron snippet with chosen time
            hh, mm = (schedule.time or "09:00").split(":", 1)
            cron = (
                f"{mm} {hh} * * 1 root /bin/sh /opt/corax-agent/run_console.sh "
                f">> /var/log/corax-agent.log 2>&1\n"
            )
            zf.writestr("cron.d/corax-agent", cron.encode("utf-8"))
    return buf.getvalue(), filename


def _write_agent_env_bat(server_url: str, agent_token: str) -> str:
    return (
        "@echo off\r\n"
        "REM Auto-generated by CORAX admin panel — do not commit to public repos.\r\n"
        f'set "INVENTORY_SERVER={server_url.rstrip("/")}"\r\n'
        f'set "AGENT_TOKEN={agent_token}"\r\n'
        "\r\n"
    )


def _write_install_schedule_bat(schedule: AgentBundleSchedule) -> str:
    """cmd + schtasks — works on Win7 and Win10 (no PowerShell 5.1)."""
    hhmm = schedule.time or "09:00"
    mode = (schedule.mode or "WEEKLY").upper()
    weekday = schedule.weekday or "MON"
    extra = ""
    if mode == "MONTHLY":
        extra = "/SC MONTHLY /D 1"
    elif mode == "DAILY":
        extra = "/SC DAILY"
    else:
        extra = f"/SC WEEKLY /D {weekday}"
    return (
        "@echo off\r\n"
        "REM Run as Administrator once. Task always starts root corax_send.bat\r\n"
        "REM (that script picks Win7 vs Win10/11).\r\n"
        "cd /d \"%~dp0\"\r\n"
        f'set "TASKNAME={schedule.task_name}"\r\n'
        "set \"BAT=%~dp0corax_send.bat\"\r\n"
        "\"%SystemRoot%\\System32\\schtasks.exe\" /Delete /TN \"%TASKNAME%\" /F >NUL 2>&1\r\n"
        f"\"%SystemRoot%\\System32\\schtasks.exe\" /Create /TN \"%TASKNAME%\" "
        f"/TR \"\\\"%BAT%\\\" nopause\" /F /RL HIGHEST {extra} /ST {hhmm}\r\n"
        "if errorlevel 1 pause\r\n"
    )


_UTF8_BOM = b"\xef\xbb\xbf"


def _bundle_file_bytes(path: Path) -> bytes:
    """PowerShell 5.1 on Windows needs UTF-8 BOM for reliable .ps1 parsing."""
    raw = path.read_bytes()
    if path.suffix.lower() != ".ps1":
        return raw
    if raw.startswith(_UTF8_BOM):
        return raw
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw
    return _UTF8_BOM + text.encode("utf-8")


def _iter_template_files(template_dir: Path) -> list[tuple[Path, str]]:
    if not template_dir.is_dir():
        raise FileNotFoundError(f"Agent template not found: {template_dir}")
    out: list[tuple[Path, str]] = []
    for path in sorted(template_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.name in _GENERATED_NAMES or path.name in _SKIP_NAMES:
            continue
        arc = path.relative_to(template_dir).as_posix()
        out.append((path, arc))
    return out


def _add_template_tree(zf: zipfile.ZipFile, template_dir: Path, prefix: str) -> None:
    for fs_path, arc_name in _iter_template_files(template_dir):
        if Path(arc_name).name in _NESTED_SKIP_NAMES:
            continue
        zf.writestr(f"{prefix}/{arc_name}", _bundle_file_bytes(fs_path))


def _build_windows_zip(body: AgentBundleCreate, server: str, token: str) -> tuple[bytes, str]:
    """One ZIP: root dispatcher + win10 (PS 5+) + win7 (PS 2) payloads. Shared agent_env.bat."""
    profile_key = "custom" if body.profile == "custom" else "full"
    config = _build_agent_config(body)
    config["agent_version"] = "3.2.0-windows"
    env_bat = _write_agent_env_bat(server, token)
    config_json = json.dumps(config, ensure_ascii=False, indent=2)
    schedule = body.schedule or AgentBundleSchedule()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    filename = f"corax-agent-windows-{profile_key}-{stamp}.zip"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for fs_path, arc_name in _iter_template_files(_AGENT_WINDOWS_WRAPPER):
            zf.writestr(arc_name, _bundle_file_bytes(fs_path))
        _add_template_tree(zf, _AGENT_WIN10_TEMPLATE, "win10")
        _add_template_tree(zf, _AGENT_WIN7_TEMPLATE, "win7")
        zf.writestr("agent_env.bat", env_bat.encode("utf-8"))
        zf.writestr("agent_config.json", config_json.encode("utf-8"))
        if schedule.enabled:
            zf.writestr("install_schedule.bat", _write_install_schedule_bat(schedule).encode("utf-8"))
    return buf.getvalue(), filename


def _build_win10_zip(body: AgentBundleCreate, server: str, token: str) -> tuple[bytes, str]:
    """Backward-compatible name: unified Windows ZIP."""
    return _build_windows_zip(body, server, token)


def _build_win7_zip(body: AgentBundleCreate, server: str, token: str) -> tuple[bytes, str]:
    """Backward-compatible name: same unified Windows ZIP as win10."""
    return _build_windows_zip(body, server, token)


async def build_agent_bundle_zip(db: AsyncSession, body: AgentBundleCreate) -> tuple[bytes, str]:
    server = body.server_url.strip().rstrip("/")
    if not server.lower().startswith(("http://", "https://")):
        raise ValueError("server_url должен начинаться с http:// или https://")

    if body.target == "cpp":
        from app.agent_cpp_build import build_cpp_agent_bundle

        return await build_cpp_agent_bundle(db, body)

    token, _ = await _resolve_agent_token(db, body)
    if body.target == "linux":
        return _build_linux_zip(body, server, token)
    return _build_windows_zip(body, server, token)
