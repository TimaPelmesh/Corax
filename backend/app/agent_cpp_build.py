"""Build and package the immutable CORAX native Windows agent."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_bundle import _resolve_agent_token, _resolve_modules
from app.schemas import AgentBundleCreate

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_CPP_ROOT = _PROJECT_ROOT / "agent" / "cpp"
_PORTABLE_ROOT = _CPP_ROOT / "portable"
_PREBUILT_EXE = _CPP_ROOT / "prebuilt" / "CORAX-Agent.template.exe"
_CACHE_DIR = _PROJECT_ROOT / "backend" / ".cache" / "corax_agent_cpp"
_TEMPLATE_EXE = _CACHE_DIR / "CORAX-Agent.template.exe"
_SRC_HASH_FILE = _CACHE_DIR / "src.hash"

_CFG_BEGIN = b"<<<CORAX_CFG_BEGIN>>>"
_CFG_END = b"<<<CORAX_CFG_END>>>"
_SLOT_BYTES = 8192


def _cmake_exe() -> Path | None:
    env = (os.environ.get("CMAKE_EXE") or "").strip()
    if env and Path(env).is_file():
        return Path(env)
    which = shutil.which("cmake")
    if which:
        return Path(which)
    vswhere = (
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
        / "Microsoft Visual Studio"
        / "Installer"
        / "vswhere.exe"
    )
    if vswhere.is_file():
        r = subprocess.run(
            [
                str(vswhere),
                "-latest",
                "-products",
                "*",
                "-requires",
                "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "-find",
                "**/cmake.exe",
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        for line in (r.stdout or "").splitlines():
            p = Path(line.strip())
            if p.is_file():
                return p
    # Known Build Tools path (dev machine)
    for cand in (
        Path(r"F:\VS\BuildTools2022\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"),
        Path(r"C:\Program Files\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"),
        Path(r"C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"),
    ):
        if cand.is_file():
            return cand
    return None


def _source_hash() -> str:
    h = hashlib.sha256()
    for path in sorted(_CPP_ROOT.rglob("*")):
        if not path.is_file():
            continue
        if "build" in path.parts:
            continue
        if path.suffix.lower() not in {
            ".cpp",
            ".hpp",
            ".h",
            ".txt",
            ".cmake",
            ".rc",
            ".manifest",
            ".ps1",
            ".cmd",
        }:
            continue
        h.update(path.relative_to(_CPP_ROOT).as_posix().encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def patch_config_slot(exe_bytes: bytes, config_json: str) -> bytes:
    """Inject JSON between CORAX config markers inside the PE image.

    The marker strings also appear as short C-string literals in the binary;
    we pick the widest BEGIN..END span (the real padded slot).
    """
    pairs: list[tuple[int, int]] = []
    start = 0
    while True:
        begin = exe_bytes.find(_CFG_BEGIN, start)
        if begin < 0:
            break
        end = exe_bytes.find(_CFG_END, begin + len(_CFG_BEGIN))
        if end < 0:
            break
        pairs.append((begin, end))
        start = begin + 1
    if not pairs:
        raise ValueError(
            "В шаблоне CORAX-Agent.exe не найден слот конфигурации "
            "(<<<CORAX_CFG_BEGIN>>>). Пересоберите агент из agent/cpp."
        )
    begin, end = max(pairs, key=lambda p: p[1] - p[0])
    payload_start = begin + len(_CFG_BEGIN)
    capacity = end - payload_start
    if capacity < 64:
        raise ValueError(
            f"Слот конфигурации слишком мал ({capacity} байт). Пересоберите CORAX-Agent.exe."
        )
    raw = config_json.encode("utf-8")
    if len(raw) > capacity:
        raise ValueError(f"Конфиг агента слишком большой ({len(raw)} > {capacity} байт)")
    patched = bytearray(exe_bytes)
    patched[payload_start:end] = raw + (b"\0" * (capacity - len(raw)))
    return bytes(patched)


def _validate_template(path: Path) -> Path:
    data = path.read_bytes()
    try:
        patch_config_slot(data, "{}")
    except ValueError as exc:
        raise RuntimeError(f"Шаблон {path.name}: слот конфига некорректен: {exc}") from exc
    return path


def _resolve_prebuilt_template() -> Path | None:
    """Shipped Windows EXE used on Linux/Docker (package-only, no MSVC)."""
    for cand in (_PREBUILT_EXE, _TEMPLATE_EXE):
        if cand.is_file() and cand.stat().st_size > 50_000:
            try:
                return _validate_template(cand)
            except RuntimeError:
                continue
    return None


def ensure_cpp_template_exe(*, force: bool = False) -> Path:
    """Return the immutable CORAX-Agent.template.exe.

    - Linux/Docker: use shipped ``agent/cpp/prebuilt/CORAX-Agent.template.exe``
      (or cached copy). No MSVC required.
    - Windows: rebuild from source when MSVC/CMake available; otherwise fall
      back to the same prebuilt template.
    """
    if not _CPP_ROOT.is_dir():
        raise FileNotFoundError(f"Не найден исходник агента: {_CPP_ROOT}")

    # Non-Windows hosts never compile PE — stamp the committed template.
    if os.name != "nt":
        pre = _resolve_prebuilt_template()
        if pre is None:
            raise RuntimeError(
                "На Linux/Docker нужен готовый шаблон "
                "agent/cpp/prebuilt/CORAX-Agent.template.exe "
                "(собирается на Windows CI / dev-машине и кладётся в репозиторий). "
                "Сборка MSVC на Linux невозможна — сервер только вшивает конфиг в EXE."
            )
        return pre

    cmake = _cmake_exe()
    if cmake is None:
        pre = _resolve_prebuilt_template()
        if pre is not None:
            return pre
        raise RuntimeError(
            "Не найден cmake.exe и нет prebuilt-шаблона. "
            "Установите VS Build Tools (MSVC + CMake) или положите "
            "agent/cpp/prebuilt/CORAX-Agent.template.exe."
        )

    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    digest = _source_hash()
    if (
        not force
        and _TEMPLATE_EXE.is_file()
        and _SRC_HASH_FILE.is_file()
        and _SRC_HASH_FILE.read_text(encoding="utf-8").strip() == digest
    ):
        return _validate_template(_TEMPLATE_EXE)

    build_dir = _CACHE_DIR / "build"
    build_dir.mkdir(parents=True, exist_ok=True)

    configure = [
        str(cmake),
        "-S",
        str(_CPP_ROOT),
        "-B",
        str(build_dir),
        "-G",
        "Visual Studio 17 2022",
        "-A",
        "x64",
        "-DCMAKE_BUILD_TYPE=Release",
    ]
    r = subprocess.run(
        configure,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        check=False,
    )
    if r.returncode != 0:
        # Fallback: let cmake pick the generator
        configure = [
            str(cmake),
            "-S",
            str(_CPP_ROOT),
            "-B",
            str(build_dir),
            "-A",
            "x64",
        ]
        r = subprocess.run(
            configure,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            check=False,
        )
        if r.returncode != 0:
            pre = _resolve_prebuilt_template()
            if pre is not None and not force:
                return pre
            raise RuntimeError(
                "CMake configure failed:\n"
                + ((r.stdout or "") + "\n" + (r.stderr or ""))[-4000:]
            )

    build = [
        str(cmake),
        "--build",
        str(build_dir),
        "--config",
        "Release",
        "--target",
        "CORAX-Agent",
        "-j",
        "4",
    ]
    r = subprocess.run(
        build,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
        check=False,
    )
    if r.returncode != 0:
        pre = _resolve_prebuilt_template()
        if pre is not None and not force:
            return pre
        raise RuntimeError(
            "CMake build failed:\n" + ((r.stdout or "") + "\n" + (r.stderr or ""))[-4000:]
        )

    candidates = [
        build_dir / "Release" / "CORAX-Agent.exe",
        build_dir / "CORAX-Agent.exe",
        build_dir / "Debug" / "CORAX-Agent.exe",
    ]
    built = next((p for p in candidates if p.is_file()), None)
    if built is None:
        raise RuntimeError("Сборка прошла, но CORAX-Agent.exe не найден в build/")

    data = built.read_bytes()
    try:
        patch_config_slot(data, "{}")
    except ValueError as exc:
        raise RuntimeError(f"Собранный EXE: слот конфига некорректен: {exc}") from exc

    shutil.copy2(built, _TEMPLATE_EXE)
    # Keep repo prebuilt in sync when rebuilding on Windows (optional for packagers).
    try:
        _PREBUILT_EXE.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(built, _PREBUILT_EXE)
    except OSError:
        pass
    _SRC_HASH_FILE.write_text(digest, encoding="utf-8")
    return _TEMPLATE_EXE


def _cpp_public_config(body: AgentBundleCreate, server: str) -> dict:
    modules = _resolve_modules(body)
    profile = "custom" if body.profile == "custom" else body.profile
    return {
        "schema_version": 1,
        "server_url": server,
        "agent_version": "5.0.0",
        "profile": profile,
        "silent": False,
        "modules": modules,
        "limits": {
            "software_max": 12000,
            "services_max": 400,
            "patches_max": 500,
        },
    }


async def build_cpp_agent_bundle(db: AsyncSession, body: AgentBundleCreate) -> tuple[bytes, str]:
    server = body.server_url.strip().rstrip("/")
    if not server.lower().startswith(("http://", "https://")):
        raise ValueError("server_url должен начинаться с http:// или https://")

    token, _ = await _resolve_agent_token(db, body)
    embed = _cpp_public_config(body, server)

    template = ensure_cpp_template_exe()
    exe = template.read_bytes()
    exe_sha256 = hashlib.sha256(exe).hexdigest()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    profile_key = "custom" if body.profile == "custom" else body.profile
    filename = f"CORAX-Agent-portable-{profile_key}-{stamp}.zip"

    provision = {
        "schema_version": 1,
        "agent_token": token,
    }
    package_meta = {
        "format": "corax-agent-portable",
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "agent_version": "5.0.0",
        "executable_sha256": exe_sha256,
        "credential_storage": "Windows DPAPI LocalMachine after first launch",
        "transport": "TLS" if server.lower().startswith("https://") else "plaintext HTTP",
    }

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr("CORAX-Agent.exe", exe, compress_type=zipfile.ZIP_STORED)
        zf.writestr(
            "agent.json",
            json.dumps(embed, ensure_ascii=False, indent=2) + "\n",
        )
        zf.writestr(
            "agent.provision.json",
            json.dumps(provision, ensure_ascii=False, separators=(",", ":")) + "\n",
        )
        zf.writestr("package.json", json.dumps(package_meta, ensure_ascii=False, indent=2) + "\n")
        zf.writestr("SHA256SUMS.txt", f"{exe_sha256}  CORAX-Agent.exe\n")
        for name in (
            "Run CORAX Agent.cmd",
            "Install scheduled task.cmd",
            "Install-CORAXScheduledTask.ps1",
            "README.txt",
        ):
            path = _PORTABLE_ROOT / name
            if not path.is_file():
                raise FileNotFoundError(f"Не найден файл portable-пакета: {path}")
            zf.writestr(name, path.read_bytes())
    return out.getvalue(), filename
