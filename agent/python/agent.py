"""
Агент инвентаризации (Python, опционально). Для пользователей: inventory_send.bat + InventoryClient.ps1.
Запуск: python agent.py
Переменные окружения: INVENTORY_SERVER, AGENT_TOKEN (как в backend/app/config.py).
"""

from __future__ import annotations

import json
import os
import platform
import re
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import psutil
import requests

_WMI_PLACEHOLDER_RE = re.compile(
    r"^(system product name|system manufacturer|system model|system version|system sku|default string|"
    r"to be filled by o\.e\.m\.|to be filled|system serial number|not specified|oem|o\.e\.m\.|"
    r"invalid|all series|type1family0|bad string|undefined|not available|n/?a|product name|not applicable)$",
    re.I,
)
_DRIVE_LETTER_RE = re.compile(r"^[A-Za-z]:$")


def _strip_nul(s: str | None) -> str | None:
    if not s:
        return s
    t = s.replace("\x00", "")
    return t if t else None


def _clean_wmi(s: str | None, max_len: int = 256) -> str | None:
    s = _strip_nul(s)
    if not s or not (t := s.strip()):
        return None
    if len(t) > max_len:
        t = t[:max_len]
    if _WMI_PLACEHOLDER_RE.match(t):
        return None
    return t


def _parse_wmic_list(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip().upper()] = v.strip()
    return out


def _run(cmd: list[str]) -> str:
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,  # type: ignore[arg-type]
        )
        return (r.stdout or "").strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def get_serial_and_oem() -> tuple[str | None, str | None, str | None, str | None, str | None]:
    """Серийник, OEM manufacturer/model, и отдельно поля материнской платы (Win32_BaseBoard)."""
    if sys.platform != "win32":
        return None, None, None, None, None
    out = _run(["wmic", "bios", "get", "serialnumber", "/value"])
    serial = None
    for line in out.splitlines():
        if line.strip().upper().startswith("SERIALNUMBER="):
            serial = _clean_wmi(line.split("=", 1)[-1])
            break
    cs = _run(["wmic", "computersystem", "get", "Manufacturer,Model", "/format:list"])
    manufacturer = model = None
    for line in cs.splitlines():
        line = line.strip()
        if line.upper().startswith("MANUFACTURER="):
            manufacturer = _clean_wmi(line.split("=", 1)[-1])
        elif line.upper().startswith("MODEL="):
            model = _clean_wmi(line.split("=", 1)[-1])

    csp = _run(["wmic", "computersystemproduct", "get", "Vendor,Name,Version,IdentifyingNumber", "/format:list"])
    kv = _parse_wmic_list(csp)
    if not manufacturer:
        manufacturer = _clean_wmi(kv.get("VENDOR"))
    if not model:
        model = _clean_wmi(kv.get("NAME")) or _clean_wmi(kv.get("VERSION")) or _clean_wmi(kv.get("IDENTIFYINGNUMBER"))

    bb = _run(["wmic", "baseboard", "get", "Manufacturer,Product,SerialNumber", "/format:list"])
    kv = _parse_wmic_list(bb)
    mb_mfr = _clean_wmi(kv.get("MANUFACTURER"))
    mb_prod = _clean_wmi(kv.get("PRODUCT"))
    if not manufacturer:
        manufacturer = mb_mfr
    if not model:
        model = mb_prod
    if not serial:
        serial = _clean_wmi(kv.get("SERIALNUMBER"))

    if not serial:
        enc = _run(["wmic", "systemenclosure", "get", "serialnumber", "/format:list"])
        serial = _clean_wmi(_parse_wmic_list(enc).get("SERIALNUMBER"))

    return serial, manufacturer, model, mb_mfr, mb_prod


def collect_memory_used_percent() -> float | None:
    try:
        return int(round(float(psutil.virtual_memory().percent)))
    except Exception:
        return None


def collect_disks() -> list[dict[str, Any]]:
    """Локальные тома с объёмом. На Windows пустой fstype у NTFS — норма, не отбрасываем."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for part in psutil.disk_partitions(all=True):
        opts = (part.opts or "").lower()
        if "cdrom" in opts or "floppy" in opts:
            continue
        if "remote" in opts:
            continue
        if sys.platform != "win32" and (part.fstype == "" or "cdrom" in opts):
            continue
        try:
            u = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        if u.total <= 0:
            continue
        mount = part.mountpoint
        if sys.platform == "win32":
            mount = mount.rstrip("\\")
            if not _DRIVE_LETTER_RE.match(mount):
                continue
        key = mount.upper()
        if key in seen:
            continue
        seen.add(key)
        total_gb = round(u.total / (1024**3), 2)
        free_gb = round(u.free / (1024**3), 2)
        used_pct = int(round(float(u.percent)))
        out.append(
            {
                "mount": mount[:64],
                "label": None,
                "total_gb": total_gb,
                "used_percent": used_pct,
                "free_gb": free_gb,
            }
        )
        if len(out) >= 24:
            break
    if sys.platform == "win32":
        vol_out = _run(
            [
                "wmic",
                "volume",
                "where",
                "DriveType=3",
                "get",
                "DriveLetter,Label,Capacity,FreeSpace,Name",
                "/format:list",
            ]
        )
        for block in vol_out.split("\n\n"):
            kv = _parse_wmic_list(block)
            cap = kv.get("CAPACITY", "").strip()
            free = kv.get("FREESPACE", "").strip()
            if not cap.isdigit() or not free.isdigit():
                continue
            total_b = float(cap)
            free_b = float(free)
            if total_b <= 0:
                continue
            mount = (kv.get("DRIVELETTER") or "").strip() or (kv.get("NAME") or "").strip()
            if not mount:
                continue
            mount = mount.rstrip("\\")
            if not _DRIVE_LETTER_RE.match(mount):
                continue
            key = mount.upper()
            if key in seen:
                continue
            seen.add(key)
            used_pct = int(round(float((total_b - free_b) * 100.0 / total_b)))
            out.append(
                {
                    "mount": mount[:64],
                    "label": (kv.get("LABEL") or "").strip()[:255] or None,
                    "total_gb": round(total_b / (1024**3), 2),
                    "used_percent": used_pct,
                    "free_gb": round(free_b / (1024**3), 2),
                }
            )
            if len(out) >= 48:
                break
    return out


_GPU_PREFER_RE = re.compile(
    r"(nvidia|amd|radeon|intel\s*arc|intel\(r\)\s*iris|intel\(r\)\s*uhd|intel\s+uhd)",
    re.I,
)
_GPU_SKIP_BASIC_RE = re.compile(r"^microsoft\s+(basic|remote)\s+display", re.I)


def _pick_gpu_name(names: list[str]) -> str | None:
    if not names:
        return None
    for n in names:
        if _GPU_PREFER_RE.search(n):
            return n[:512]
    for n in names:
        if not _GPU_SKIP_BASIC_RE.match(n):
            return n[:512]
    return names[0][:512]


def gpu_name_windows() -> str | None:
    if sys.platform != "win32":
        return None
    ps_cmd = (
        "Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | "
        "ForEach-Object { $_.Name }"
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
            capture_output=True,
            text=True,
            timeout=45,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,  # type: ignore[arg-type]
        )
        names = [ln.strip() for ln in (r.stdout or "").splitlines() if ln.strip()]
        picked = _pick_gpu_name(names)
        if picked:
            return picked
    except (OSError, subprocess.TimeoutExpired):
        pass
    out = _run(["wmic", "path", "win32_VideoController", "get", "Name", "/value"])
    names_wmic: list[str] = []
    for line in out.splitlines():
        line = line.strip()
        if line.upper().startswith("NAME="):
            n = line.split("=", 1)[-1].strip()
            if n:
                names_wmic.append(n)
    return _pick_gpu_name(names_wmic)


def primary_mac() -> str | None:
    for name, addrs in psutil.net_if_addrs().items():
        if "loopback" in name.lower() or name.lower().startswith("lo"):
            continue
        for a in addrs:
            addr = getattr(a, "address", "") or ""
            if len(addr) >= 17 and (":" in addr or "-" in addr) and addr[0].isalnum():
                return addr.replace("-", ":").upper()
    return None


_UNINSTALL_SUBKEYS = (
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
)


def _enum_uninstall_under(
    hkey: int,
    subpath: str,
    seen: set[tuple[str, str]],
    out: list[dict[str, str | None]],
    max_items: int,
    reg: Any,
) -> None:
    if len(out) >= max_items:
        return
    try:
        k = reg.OpenKey(hkey, subpath)
    except OSError:
        return
    try:
        i = 0
        while len(out) < max_items:
            try:
                sub = reg.EnumKey(k, i)
            except OSError:
                break
            i += 1
            try:
                sk = reg.OpenKey(k, sub)
                try:
                    name = reg.QueryValueEx(sk, "DisplayName")[0]
                except OSError:
                    reg.CloseKey(sk)
                    continue
                ver = None
                try:
                    ver = reg.QueryValueEx(sk, "DisplayVersion")[0]
                except OSError:
                    pass
                reg.CloseKey(sk)
                if not name or not isinstance(name, str):
                    continue
                nm = (_strip_nul(name.strip()) or "")[:512]
                if not nm:
                    continue
                vs: str | None = None
                if ver is not None:
                    vs = (_strip_nul(str(ver).strip()) or None)
                    if vs:
                        vs = vs[:255]
                dedupe = (nm.lower(), (vs or "").lower())
                if dedupe in seen:
                    continue
                seen.add(dedupe)
                out.append({"name": nm, "version": vs})
            except OSError:
                continue
    finally:
        reg.CloseKey(k)


def list_installed_software_windows(max_items: int = 12000) -> list[dict[str, str | None]]:
    """Реестр Uninstall: HKLM, HKCU, профили HKEY_USERS (S-1-5-21-*). Версии DisplayVersion, дедуп по имени+версии."""
    if sys.platform != "win32":
        return []
    try:
        import winreg  # type: ignore
    except ImportError:
        return []

    out: list[dict[str, str | None]] = []
    seen: set[tuple[str, str]] = set()
    reg = winreg
    for path in _UNINSTALL_SUBKEYS:
        _enum_uninstall_under(reg.HKEY_LOCAL_MACHINE, path, seen, out, max_items, reg)
    for path in _UNINSTALL_SUBKEYS:
        _enum_uninstall_under(reg.HKEY_CURRENT_USER, path, seen, out, max_items, reg)

    try:
        hu = reg.OpenKey(reg.HKEY_USERS, "")
    except OSError:
        hu = None
    if hu is not None:
        try:
            idx = 0
            while len(out) < max_items:
                try:
                    sid = reg.EnumKey(hu, idx)
                except OSError:
                    break
                idx += 1
                if not sid.startswith("S-1-5-21-"):
                    continue
                for tail in _UNINSTALL_SUBKEYS:
                    _enum_uninstall_under(reg.HKEY_USERS, f"{sid}\\{tail}", seen, out, max_items, reg)
        finally:
            reg.CloseKey(hu)

    out.sort(key=lambda x: (x["name"] or "").lower())
    return out[:max_items]


def collect_pnp_peripherals_windows(max_items: int = 80) -> list[dict[str, str]]:
    """Те же классы PnP, что в InventoryClient.ps1 / pnp_peripherals.ps1 (камеры, аудио, BT, NIC …)."""
    if sys.platform != "win32":
        return []
    script = Path(__file__).resolve().parent / "pnp_peripherals.ps1"
    if not script.is_file():
        return []
    try:
        r = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script),
                str(max_items),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,  # type: ignore[arg-type]
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    out = (r.stdout or "").strip()
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return []
    res: list[dict[str, str]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        k, n = item.get("kind"), item.get("name")
        if isinstance(k, str) and isinstance(n, str) and k.strip() and n.strip():
            res.append({"kind": k.strip()[:32], "name": n.strip()[:512]})
    return res[:max_items]


def collect_printers_windows() -> list[dict[str, Any]]:
    if sys.platform != "win32":
        return []
    script = Path(__file__).resolve().parent / "collect_printers.ps1"
    if not script.is_file():
        return []
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,  # type: ignore[arg-type]
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    out = (r.stdout or "").strip()
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)]


def collect_report() -> dict[str, Any]:
    hostname = ((os.environ.get("COMPUTERNAME") or "").strip() or (socket.gethostname() or "").strip() or "unknown-host")
    ram_gb = round(psutil.virtual_memory().total / (1024**3), 2)
    cpu = platform.processor() or "unknown"
    if sys.platform == "win32" and (not cpu or cpu == "Intel64 Family 6 Model"):
        try:
            import ctypes

            buf = ctypes.create_unicode_buffer(256)
            if ctypes.windll.kernel32.GetEnvironmentVariableW("PROCESSOR_IDENTIFIER", buf, 256):
                cpu = buf.value
        except Exception:
            pass

    serial, manufacturer, model, mb_mfr, mb_prod = get_serial_and_oem()
    if not mb_prod and model:
        mb_prod = model
    if not mb_mfr and manufacturer:
        mb_mfr = manufacturer
    mac = primary_mac()
    ver = platform.version()
    rel = platform.release()

    mem_pct = collect_memory_used_percent()
    disks = collect_disks()
    gpu = gpu_name_windows() if sys.platform == "win32" else None

    if sys.platform == "win32":
        software = list_installed_software_windows()
        peripherals = collect_pnp_peripherals_windows(max_items=140)
        printers = collect_printers_windows()
    else:
        software = [{"name": f"{platform.system()} {platform.release()}", "version": platform.version()}]
        peripherals = []
        printers = []

    return {
        "hostname": hostname,
        "serial_number": serial,
        "mac_primary": mac,
        "cpu": cpu[:512],
        "ram_gb": ram_gb,
        "memory_used_percent": mem_pct,
        "gpu_name": gpu,
        "disks": disks,
        "os_name": platform.system(),
        "os_version": f"{rel} {ver}".strip(),
        "manufacturer": manufacturer,
        "model": model,
        "motherboard_manufacturer": mb_mfr,
        "motherboard_product": mb_prod,
        "software": software,
        "peripherals": peripherals,
        "printers": printers,
    }


def main() -> None:
    server = (os.environ.get("INVENTORY_SERVER") or "").strip().rstrip("/")
    token = (os.environ.get("AGENT_TOKEN") or "").strip()
    if not server:
        print("ERROR: INVENTORY_SERVER is not set. Example: http://127.0.0.1:3001", file=sys.stderr)
        sys.exit(2)
    if not token:
        print("ERROR: AGENT_TOKEN is not set. Ask admin for an agent token.", file=sys.stderr)
        sys.exit(2)
    report = collect_report()
    url = f"{server}/api/v1/agent/inventory"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload_bytes = json.dumps(report, ensure_ascii=False).encode("utf-8")

    # On older Windows/domain setups the user profile may be on a UNC path (\\server\profiles\...),
    # which is unreliable/offline for store-and-forward. Prefer ProgramData (local) by default.
    queue_dir_env = (os.environ.get("INVENTORY_QUEUE_DIR") or "").strip()
    if queue_dir_env:
        queue_dir = Path(queue_dir_env)
    elif sys.platform == "win32":
        root = (os.environ.get("ProgramData") or os.environ.get("TEMP") or "").strip()
        queue_dir = Path(root) / "InventoryAgent" if root else Path.cwd() / "InventoryAgent"
    else:
        queue_dir = Path.home() / ".inventory_agent"
    queue_dir.mkdir(parents=True, exist_ok=True)
    queue_file = queue_dir / "pending_report.json"

    def try_send(body: bytes) -> bool:
        backoff = [2, 5, 15]
        for attempt in range(1, len(backoff) + 2):
            try:
                r = requests.post(url, data=body, headers=headers, timeout=120)
            except requests.RequestException as exc:
                if attempt <= len(backoff):
                    time.sleep(backoff[attempt - 1])
                    continue
                print("ERROR: network failure:", exc, file=sys.stderr)
                return False
            if r.status_code >= 500:
                if attempt <= len(backoff):
                    time.sleep(backoff[attempt - 1])
                    continue
                print("ERROR: server error:", r.status_code, r.text, file=sys.stderr)
                return False
            if r.status_code >= 400:
                print("ERROR:", r.status_code, r.text, file=sys.stderr)
                return False
            try:
                print("OK:", r.json())
            except Exception:
                print("OK")
            return True
        return False

    # Store-and-forward: send previous unsent report first.
    if queue_file.is_file():
        try:
            prev = queue_file.read_bytes()
        except OSError:
            prev = b""
        if prev:
            print("Found pending report, sending first...")
            if try_send(prev):
                try:
                    queue_file.unlink(missing_ok=True)
                except OSError:
                    pass

    print("Sending to", url)
    print("Host:", report["hostname"], "| software:", len(report["software"]), "| pnp:", len(report["peripherals"]))
    if not try_send(payload_bytes):
        try:
            queue_file.write_bytes(payload_bytes)
            print("Saved pending report to", str(queue_file), file=sys.stderr)
        except OSError:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()

