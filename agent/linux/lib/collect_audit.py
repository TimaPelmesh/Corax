#!/usr/bin/env python3
"""Live Linux telemetry for the CORAX server-audit tab.

Reads /proc and /sys, plus a few standard Debian tools when they exist.
Does not read secrets, command lines, home directories, or the CORAX server tree.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

SAMPLE_SEC = 0.45
AGENT_VERSION = os.environ.get("CORAX_AGENT_VERSION") or "3.2.0-linux"

_SKIP_FSTYPE = {
    "tmpfs",
    "devtmpfs",
    "proc",
    "sysfs",
    "cgroup",
    "cgroup2",
    "squashfs",
    "devpts",
    "securityfs",
    "pstore",
    "bpf",
    "tracefs",
    "debugfs",
    "fusectl",
    "configfs",
    "mqueue",
    "hugetlbfs",
    "ramfs",
    "autofs",
    "binfmt_misc",
    "nsfs",
    "rpc_pipefs",
}
_SKIP_MOUNT_PREFIX = ("/proc", "/sys", "/dev", "/run", "/snap")
_SKIP_BLOCK = ("loop", "ram", "fd", "sr", "zram", "dm-")


def _read(path: str, limit: int = 200_000) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(limit)
    except OSError:
        return ""


def _run(argv: list[str], timeout: float = 3.0) -> str:
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "LC_ALL": "C"},
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return proc.stdout or ""


def _hostname() -> str:
    out = _run(["hostname", "-s"], timeout=2).strip()
    if out:
        return out.split()[0][:255]
    try:
        name = socket.gethostname().split(".")[0].strip()
    except OSError:
        name = ""
    if not name:
        name = _read("/etc/hostname").splitlines()[0].strip() if _read("/etc/hostname") else ""
    return name[:255] or "unknown-host"


def _os_release() -> dict[str, str]:
    data: dict[str, str] = {}
    for line in _read("/etc/os-release").splitlines():
        if "=" not in line or line.startswith("#"):
            continue
        key, val = line.split("=", 1)
        data[key.strip()] = val.strip().strip('"')
    return data


def _read_cpu() -> dict[str, tuple[int, int]]:
    totals: dict[str, tuple[int, int]] = {}
    text = _read("/proc/stat")
    for line in text.splitlines():
        if not line.startswith("cpu"):
            break
        parts = line.split()
        nums = []
        for item in parts[1:]:
            try:
                nums.append(int(item))
            except ValueError:
                nums.append(0)
        if not nums:
            continue
        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
        totals[parts[0]] = (sum(nums), idle)
    return totals


def _pct(before: tuple[int, int] | None, after: tuple[int, int] | None) -> float | None:
    if not before or not after:
        return None
    delta = after[0] - before[0]
    idle = after[1] - before[1]
    if delta <= 0:
        return None
    used = 100.0 * (delta - idle) / delta
    if used < 0:
        used = 0.0
    if used > 100:
        used = 100.0
    return round(used, 1)


def _read_diskstats() -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    for line in _read("/proc/diskstats").splitlines():
        parts = line.split()
        if len(parts) < 14:
            continue
        name = parts[2]
        try:
            out[name] = (int(parts[5]), int(parts[9]))
        except ValueError:
            continue
    return out


def _whole_disks() -> set[str]:
    root = Path("/sys/block")
    names: set[str] = set()
    if not root.is_dir():
        return names
    for entry in root.iterdir():
        name = entry.name
        if name.startswith(_SKIP_BLOCK):
            continue
        names.add(name)
    return names


def _read_netdev() -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    for line in _read("/proc/net/dev").splitlines():
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        name = name.strip()
        if not name or name == "lo":
            continue
        nums = rest.split()
        if len(nums) < 9:
            continue
        try:
            out[name] = (int(nums[0]), int(nums[8]))
        except ValueError:
            continue
    return out


def _rates(before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]], dt: float) -> dict[str, tuple[float, float]]:
    rates: dict[str, tuple[float, float]] = {}
    if dt <= 0:
        return rates
    for name, (rx2, tx2) in after.items():
        prev = before.get(name)
        if not prev:
            continue
        rx = max(0, rx2 - prev[0]) / dt
        tx = max(0, tx2 - prev[1]) / dt
        rates[name] = (round(rx, 1), round(tx, 1))
    return rates


def _temperatures() -> list[dict]:
    rows: list[dict] = []
    thermal = Path("/sys/class/thermal")
    if thermal.is_dir():
        for zone in sorted(thermal.glob("thermal_zone*")):
            kind = _read(str(zone / "type")).strip() or zone.name
            raw = _read(str(zone / "temp")).strip()
            celsius = _milli_c(raw)
            if celsius is None:
                continue
            rows.append({"name": kind[:80], "celsius": celsius, "source": "thermal"})
    hwmon = Path("/sys/class/hwmon")
    if hwmon.is_dir():
        for mon in sorted(hwmon.glob("hwmon*")):
            chip = _read(str(mon / "name")).strip() or mon.name
            for temp in sorted(mon.glob("temp*_input")):
                idx = temp.name.replace("temp", "").replace("_input", "")
                label = _read(str(mon / f"temp{idx}_label")).strip()
                name = label or f"{chip} temp{idx}"
                celsius = _milli_c(_read(str(temp)).strip())
                if celsius is None:
                    continue
                rows.append({"name": name[:80], "celsius": celsius, "source": chip[:40] or "hwmon"})
    uniq: list[dict] = []
    seen: set[tuple[str, float]] = set()
    for row in rows:
        key = (str(row["name"]).lower(), float(row["celsius"]))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(row)
        if len(uniq) >= 32:
            break
    return uniq


def _milli_c(raw: str) -> float | None:
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return None
    if n > 1000:
        n = n / 1000.0
    if n < 1 or n > 140:
        return None
    return round(n, 1)


def _headline_temp(rows: list[dict]) -> float | None:
    if not rows:
        return None
    preferred = []
    for row in rows:
        name = str(row.get("name") or "").lower()
        if any(token in name for token in ("pkg", "tctl", "k10", "cpu", "core", "x86", "soc", "package")):
            preferred.append(float(row["celsius"]))
    pool = preferred or [float(row["celsius"]) for row in rows]
    return round(max(pool), 1)


def _fans() -> list[dict]:
    rows: list[dict] = []
    hwmon = Path("/sys/class/hwmon")
    if not hwmon.is_dir():
        return rows
    for mon in sorted(hwmon.glob("hwmon*")):
        chip = _read(str(mon / "name")).strip() or mon.name
        for fan in sorted(mon.glob("fan*_input")):
            idx = fan.name.replace("fan", "").replace("_input", "")
            label = _read(str(mon / f"fan{idx}_label")).strip() or f"{chip} fan{idx}"
            try:
                rpm = int(float(_read(str(fan)).strip() or "0"))
            except ValueError:
                continue
            if rpm <= 0 or rpm > 30000:
                continue
            rows.append({"name": label[:80], "rpm": rpm})
            if len(rows) >= 16:
                return rows
    return rows


def _meminfo() -> dict[str, int]:
    out: dict[str, int] = {}
    for line in _read("/proc/meminfo").splitlines():
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        digits = "".join(ch for ch in rest if ch.isdigit())
        if digits:
            out[key.strip()] = int(digits)
    return out


def _memory(info: dict[str, int]) -> dict:
    total = info.get("MemTotal") or 0
    avail = info.get("MemAvailable") or 0
    swap_total = info.get("SwapTotal") or 0
    swap_free = info.get("SwapFree") or 0
    used = max(0, total - avail) if total and avail else 0
    swap_used = max(0, swap_total - swap_free)

    def mb(kb: int) -> int:
        return int(round(kb / 1024.0))

    used_pct = int(round(100.0 * used / total)) if total else 0
    swap_pct = int(round(100.0 * swap_used / swap_total)) if swap_total else 0
    return {
        "total_mb": mb(total),
        "available_mb": mb(avail),
        "used_mb": mb(used),
        "used_percent": used_pct,
        "swap_total_mb": mb(swap_total),
        "swap_used_mb": mb(swap_used),
        "swap_used_percent": swap_pct,
        "buffers_mb": mb(info.get("Buffers") or 0),
        "cached_mb": mb(info.get("Cached") or 0),
    }


def _load() -> dict[str, float]:
    parts = _read("/proc/loadavg").split()
    vals: list[float] = []
    for item in parts[:3]:
        try:
            vals.append(round(float(item), 2))
        except ValueError:
            vals.append(0.0)
    while len(vals) < 3:
        vals.append(0.0)
    return {"1": vals[0], "5": vals[1], "15": vals[2]}


def _uptime() -> int:
    raw = _read("/proc/uptime").split()
    if not raw:
        return 0
    try:
        return max(0, int(float(raw[0])))
    except ValueError:
        return 0


def _df() -> list[dict]:
    text = _run(["df", "-P", "-T", "-k"], timeout=8)
    inodes = _run(["df", "-P", "-i"], timeout=8)
    inode_by_mount: dict[str, int] = {}
    for line in inodes.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        mount = " ".join(parts[5:])
        pct = parts[4].rstrip("%")
        try:
            inode_by_mount[mount] = int(float(pct))
        except ValueError:
            continue
    rows: list[dict] = []
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 7:
            continue
        fstype = parts[1]
        mount = " ".join(parts[6:])
        if fstype in _SKIP_FSTYPE:
            continue
        if any(mount == prefix or mount.startswith(prefix + "/") for prefix in _SKIP_MOUNT_PREFIX):
            continue
        try:
            total_kb = float(parts[2])
            used_kb = float(parts[3])
            avail_kb = float(parts[4])
            pct = int(float(parts[5].rstrip("%")))
        except ValueError:
            continue
        if total_kb <= 0:
            continue
        rows.append(
            {
                "mount": mount[:255],
                "fstype": fstype[:32],
                "total_gb": round(total_kb / 1024 / 1024, 2),
                "free_gb": round(avail_kb / 1024 / 1024, 2),
                "used_gb": round(used_kb / 1024 / 1024, 2),
                "used_percent": max(0, min(100, pct)),
                "inodes_used_percent": inode_by_mount.get(mount),
            }
        )
        if len(rows) >= 32:
            break
    return rows


def _root_disk(rows: list[dict]) -> dict | None:
    for row in rows:
        if row.get("mount") == "/":
            return row
    if not rows:
        return None
    return max(rows, key=lambda row: float(row.get("total_gb") or 0))


def _cpu_model() -> tuple[str, int, float | None]:
    model = ""
    cores = 0
    for line in _read("/proc/cpuinfo").splitlines():
        if line.startswith("processor"):
            cores += 1
        elif not model and line.lower().startswith("model name"):
            model = line.split(":", 1)[-1].strip()
        elif not model and line.lower().startswith(("hardware", "cpu model", "model")):
            model = line.split(":", 1)[-1].strip()
    mhz = None
    freq = _read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq").strip()
    if freq.isdigit():
        mhz = round(int(freq) / 1000.0, 0)
    if not model:
        model = os.uname().machine
    return model[:255], cores, mhz


def _ipv4_map() -> dict[str, str]:
    text = _run(["ip", "-4", "-o", "addr", "show"], timeout=3)
    found: dict[str, str] = {}
    for line in text.splitlines():
        match = re.search(r"^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)", line)
        if not match:
            continue
        name, ip = match.group(1), match.group(2)
        if name not in found and not ip.startswith("127."):
            found[name] = ip
    return found


def _network(rates: dict[str, tuple[float, float]], counters: dict[str, tuple[int, int]]) -> list[dict]:
    ipv4 = _ipv4_map()
    rows: list[dict] = []
    names = sorted(set(counters) | set(rates))
    for name in names:
        if name.startswith(("lo", "docker", "veth", "br-", "virbr", "tun", "tap", "wg")):
            continue
        rx_b, tx_b = counters.get(name, (0, 0))
        rx_bps, tx_bps = rates.get(name, (0.0, 0.0))
        mac = _read(f"/sys/class/net/{name}/address").strip()
        speed = _read(f"/sys/class/net/{name}/speed").strip()
        state = _read(f"/sys/class/net/{name}/operstate").strip()
        speed_mbps = int(speed) if speed.lstrip("-").isdigit() and int(speed) > 0 else None
        rows.append(
            {
                "name": name[:32],
                "mac": mac[:32] or None,
                "ipv4": ipv4.get(name),
                "operstate": state[:16] or None,
                "speed_mbps": speed_mbps,
                "rx_bps": rx_bps,
                "tx_bps": tx_bps,
                "rx_bytes": rx_b,
                "tx_bytes": tx_b,
            }
        )
        if len(rows) >= 16:
            break
    return rows


def _disk_io(rates: dict[str, tuple[float, float]]) -> list[dict]:
    rows = []
    for name in sorted(rates):
        if name not in _whole_disks() and not name.startswith("dm-"):
            continue
        if name.startswith(_SKIP_BLOCK):
            continue
        read_bps, write_bps = rates[name]
        model = _read(f"/sys/block/{name}/device/model").strip()
        rows.append(
            {
                "name": name[:32],
                "model": model[:80] or None,
                "read_bps": round(read_bps * 512, 1),
                "write_bps": round(write_bps * 512, 1),
            }
        )
        if len(rows) >= 16:
            break
    return rows


def _processes() -> tuple[list[dict], int]:
    text = _run(["ps", "-eo", "pid,user,pcpu,pmem,rss,comm", "--sort=-pcpu"], timeout=4)
    rows: list[dict] = []
    count = 0
    for line in text.splitlines()[1:]:
        count += 1
        parts = line.split(None, 5)
        if len(parts) < 6 or len(rows) >= 20:
            continue
        try:
            pid = int(parts[0])
            cpu = float(parts[2])
            mem = float(parts[3])
            rss_kb = float(parts[4])
        except ValueError:
            continue
        rows.append(
            {
                "pid": pid,
                "user": parts[1][:32],
                "cpu": round(cpu, 1),
                "mem": round(mem, 1),
                "rss_mb": round(rss_kb / 1024.0, 1),
                "name": parts[5].strip()[:64],
            }
        )
    if count == 0:
        proc = Path("/proc")
        if proc.is_dir():
            count = sum(1 for entry in proc.iterdir() if entry.name.isdigit())
    return rows, count


def _failed_units() -> list[dict]:
    text = _run(["systemctl", "--failed", "--no-legend", "--plain", "--no-pager"], timeout=4)
    rows: list[dict] = []
    for line in text.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4:
            continue
        if parts[0] in {"UNIT", "0"}:
            continue
        rows.append({"name": parts[0][:128], "active": parts[2][:32], "sub": parts[3][:32]})
        if len(rows) >= 30:
            break
    return rows


def _listeners() -> list[dict]:
    text = _run(["ss", "-H", "-lntu"], timeout=4)
    rows: list[dict] = []
    seen: set[str] = set()
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        proto = parts[0][:8]
        addr = parts[4][:80]
        key = f"{proto} {addr}"
        if key in seen:
            continue
        seen.add(key)
        rows.append({"proto": proto, "address": addr})
        if len(rows) >= 60:
            break
    return rows


def _sessions() -> list[dict]:
    text = _run(["who"], timeout=3)
    rows: list[dict] = []
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        rows.append(
            {
                "user": parts[0][:32],
                "tty": parts[1][:32] if len(parts) > 1 else None,
                "from": parts[-1][:64] if len(parts) > 2 and parts[-1].startswith("(") else None,
            }
        )
        if len(rows) >= 20:
            break
    return rows


def _packages() -> dict:
    installed = 0
    status = Path("/var/lib/dpkg/status")
    if status.is_file():
        try:
            with status.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if line.startswith("Status:") and "ok installed" in line:
                        installed += 1
        except OSError:
            installed = 0
    updates = None
    security = None
    apt_check = Path("/usr/lib/update-notifier/apt-check")
    if apt_check.is_file():
        raw = _run([str(apt_check)], timeout=8).strip()
        if ";" in raw:
            left, right = raw.split(";", 1)
            if left.strip().isdigit():
                updates = int(left.strip())
            if right.strip().isdigit():
                security = int(right.strip())
    return {
        "installed": installed,
        "reboot_required": Path("/var/run/reboot-required").is_file(),
        "updates": updates,
        "security_updates": security,
    }


def _virt() -> tuple[str, bool]:
    container = Path("/.dockerenv").is_file() or "docker" in _read("/proc/1/cgroup") or "lxc" in _read("/proc/1/cgroup")
    detected = _run(["systemd-detect-virt"], timeout=2).strip()
    if detected and detected != "none":
        return detected[:32], container
    if "hypervisor" in _read("/proc/cpuinfo"):
        return "kvm", container
    product = _read("/sys/class/dmi/id/product_name").strip().lower()
    for token in ("kvm", "vmware", "virtualbox", "qemu", "xen", "hyper-v", "bochs"):
        if token in product:
            return token, container
    return "physical" if not container else "container", container


def _pressure() -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    for kind in ("cpu", "memory", "io"):
        text = _read(f"/proc/pressure/{kind}")
        match = re.search(r"avg10=([0-9.]+)", text)
        try:
            out[kind] = round(float(match.group(1)), 2) if match else None
        except ValueError:
            out[kind] = None
    return out


def _sockstat() -> dict[str, int | None]:
    tcp_inuse = None
    udp_inuse = None
    for line in _read("/proc/net/sockstat").splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0] == "TCP:" and parts[1] == "inuse" and parts[2].isdigit():
            tcp_inuse = int(parts[2])
        if len(parts) >= 3 and parts[0] == "UDP:" and parts[1] == "inuse" and parts[2].isdigit():
            udp_inuse = int(parts[2])
    return {"tcp_inuse": tcp_inuse, "udp_inuse": udp_inuse}


def _file_nr() -> dict[str, int | None]:
    parts = _read("/proc/sys/fs/file-nr").split()
    nums = [int(p) for p in parts if p.isdigit()]
    return {
        "allocated": nums[0] if len(nums) > 0 else None,
        "unused": nums[1] if len(nums) > 1 else None,
        "max": nums[2] if len(nums) > 2 else None,
    }


def _docker() -> list[dict]:
    if not _run(["docker", "--version"], timeout=2).strip():
        return []
    text = _run(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"], timeout=4)
    rows: list[dict] = []
    for line in text.splitlines():
        parts = line.split("\t")
        if not parts or not parts[0].strip():
            continue
        rows.append(
            {
                "name": parts[0].strip()[:80],
                "status": parts[1].strip()[:80] if len(parts) > 1 else None,
                "image": parts[2].strip()[:120] if len(parts) > 2 else None,
            }
        )
        if len(rows) >= 20:
            break
    return rows


def _ntp() -> bool | None:
    raw = _run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"], timeout=3).strip().lower()
    if raw == "yes":
        return True
    if raw == "no":
        return False
    return None


def build_audit() -> dict:
    cpu_before = _read_cpu()
    disk_before = _read_diskstats()
    net_before = _read_netdev()
    started = time.monotonic()
    time.sleep(SAMPLE_SEC)
    elapsed = max(0.05, time.monotonic() - started)
    cpu_after = _read_cpu()
    disk_after = _read_diskstats()
    net_after = _read_netdev()

    cpu_pct = _pct(cpu_before.get("cpu"), cpu_after.get("cpu"))
    per_core: list[float] = []
    for key in sorted(k for k in cpu_after if k.startswith("cpu") and k != "cpu"):
        value = _pct(cpu_before.get(key), cpu_after.get(key))
        if value is None:
            continue
        per_core.append(value)
        if len(per_core) >= 64:
            break

    temps = _temperatures()
    memory = _memory(_meminfo())
    load = _load()
    disks = _df()
    root = _root_disk(disks)
    net_rates = _rates(net_before, net_after, elapsed)
    disk_rates = _rates(disk_before, disk_after, elapsed)
    network = _network(net_rates, net_after)
    disk_io = _disk_io(disk_rates)
    processes, process_count = _processes()
    failed = _failed_units()
    model, cores, mhz = _cpu_model()
    release = _os_release()
    virt, container = _virt()
    uname = os.uname()
    rx_bps = round(sum(row["rx_bps"] for row in network), 1)
    tx_bps = round(sum(row["tx_bps"] for row in network), 1)
    temp_c = _headline_temp(temps)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    summary = {
        "cpu_temp_c": temp_c,
        "cpu_used_percent": cpu_pct if cpu_pct is not None else 0.0,
        "load_1": load["1"],
        "load_5": load["5"],
        "load_15": load["15"],
        "mem_used_percent": memory["used_percent"],
        "mem_total_mb": memory["total_mb"],
        "mem_used_mb": memory["used_mb"],
        "swap_used_percent": memory["swap_used_percent"],
        "swap_total_mb": memory["swap_total_mb"],
        "disk_used_percent": root["used_percent"] if root else None,
        "disk_total_gb": root["total_gb"] if root else None,
        "disk_free_gb": root["free_gb"] if root else None,
        "net_rx_bps": rx_bps,
        "net_tx_bps": tx_bps,
        "uptime_sec": _uptime(),
        "process_count": process_count,
        "failed_units": len(failed),
    }
    return {
        "hostname": _hostname(),
        "collected_at": now,
        "agent_version": AGENT_VERSION,
        "summary": summary,
        "os": {
            "pretty": (release.get("PRETTY_NAME") or release.get("NAME") or "Linux")[:255],
            "id": (release.get("ID") or "")[:64],
            "version": (release.get("VERSION_ID") or "")[:64],
            "kernel": uname.release[:128],
            "arch": uname.machine[:32],
            "virt": virt,
            "container": container,
        },
        "cpu": {
            "model": model,
            "cores": cores,
            "mhz": mhz,
            "used_percent": summary["cpu_used_percent"],
            "per_core": per_core,
        },
        "temperatures": temps,
        "fans": _fans(),
        "memory": memory,
        "load": load,
        "uptime_sec": summary["uptime_sec"],
        "disks": disks,
        "disk_io": disk_io,
        "network": network,
        "processes": processes,
        "failed_units": failed,
        "listeners": _listeners(),
        "sessions": _sessions(),
        "packages": _packages(),
        "pressure": _pressure(),
        "sockets": _sockstat(),
        "files": _file_nr(),
        "docker": _docker(),
        "time": {"utc": now, "ntp_synchronized": _ntp()},
    }


def main() -> int:
    payload = build_audit()
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(sys.argv) >= 2:
        Path(sys.argv[1]).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
