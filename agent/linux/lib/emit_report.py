#!/usr/bin/env python3
"""Assemble CORAX AgentInventoryReport JSON from collect workdir (no deps)."""
from __future__ import annotations

import json
import sys
from pathlib import Path


def meta(wd: Path, key: str) -> str | None:
    p = wd / "meta" / key
    if not p.is_file():
        return None
    try:
        v = p.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    return v or None


def meta_float(wd: Path, key: str) -> float | None:
    v = meta(wd, key)
    if v is None:
        return None
    v = v.replace("\u00a0", " ").replace(" ", "").replace(",", ".")
    try:
        n = float(v)
    except ValueError:
        return None
    if n <= 0:
        return None
    return n


def meta_int(wd: Path, key: str) -> int | None:
    v = meta(wd, key)
    if v is None:
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def read_tsv(path: Path) -> list[list[str]]:
    if not path.is_file():
        return []
    rows: list[list[str]] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    for line in text.splitlines():
        if not line.strip():
            continue
        rows.append(line.split("\t"))
    return rows


def uniq_keep(items: list[dict], key_fn) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for it in items:
        k = key_fn(it)
        if k in seen:
            continue
        seen.add(k)
        out.append(it)
    return out


def build(wd: Path) -> dict:
    hostname = meta(wd, "hostname") or "unknown-host"
    disks = []
    for row in read_tsv(wd / "disks.tsv"):
        if len(row) < 5:
            continue
        try:
            disks.append(
                {
                    "mount": row[0][:255],
                    "label": row[1] or None,
                    "total_gb": float(row[2]),
                    "used_percent": int(float(row[3])),
                    "free_gb": float(row[4]),
                }
            )
        except (ValueError, IndexError):
            continue

    software = []
    for row in read_tsv(wd / "software.tsv"):
        name = (row[0] if row else "").strip()
        if not name:
            continue
        ver = (row[1].strip() if len(row) > 1 else "") or None
        software.append({"name": name[:512], "version": (ver[:255] if ver else None)})
    software = uniq_keep(software, lambda x: f"{x['name'].lower()}|{(x.get('version') or '').lower()}")

    peripherals = []
    for row in read_tsv(wd / "peripherals.tsv"):
        if len(row) < 2:
            continue
        kind = (row[0] or "other")[:32]
        name = row[1].strip()[:512]
        if not name:
            continue
        peripherals.append({"kind": kind, "name": name})
    peripherals = uniq_keep(peripherals, lambda x: f"{x['kind']}|{x['name'].lower()}")[:200]

    adapters = []
    for row in read_tsv(wd / "adapters.tsv"):
        if len(row) < 2:
            continue
        adapters.append(
            {
                "name": row[0],
                "mac": row[1],
                "ipv4": row[2] if len(row) > 2 else None,
                "ipv6": row[3] if len(row) > 3 else None,
            }
        )

    dns = []
    dns_path = wd / "dns.txt"
    if dns_path.is_file():
        dns = sorted({ln.strip() for ln in dns_path.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()})

    gateways = []
    gw_path = wd / "gateways.txt"
    if gw_path.is_file():
        gateways = sorted({ln.strip() for ln in gw_path.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()})

    sessions = []
    for row in read_tsv(wd / "sessions.tsv"):
        if not row:
            continue
        sessions.append({"user": row[0], "tty": row[1] if len(row) > 1 else None, "since": row[2] if len(row) > 2 else None})

    services = []
    for row in read_tsv(wd / "services.tsv")[:400]:
        if not row:
            continue
        services.append({"name": row[0], "status": row[1] if len(row) > 1 else None})

    patches = []
    for row in read_tsv(wd / "patches.tsv")[:500]:
        if not row:
            continue
        patches.append({"name": row[0], "version": row[1] if len(row) > 1 else None})

    physical_disks = []
    for row in read_tsv(wd / "physical_disks.tsv"):
        if len(row) < 2:
            continue
        try:
            size_b = int(float(row[1]))
            size_gb = round(size_b / (1024**3), 2) if size_b > 0 else None
        except ValueError:
            size_gb = None
        physical_disks.append(
            {
                "name": row[0],
                "size_gb": size_gb,
                "media": row[2] if len(row) > 2 else None,
                "model": row[3] if len(row) > 3 else None,
                "serial": row[4] if len(row) > 4 else None,
            }
        )

    sb = meta(wd, "secure_boot_enabled")
    secure_boot = None
    if sb == "true":
        secure_boot = True
    elif sb == "false":
        secure_boot = False

    extended = {
        "agent_version": meta(wd, "agent_version") or "3.1.0-linux",
        "profile": meta(wd, "profile") or "full",
        "collected_at": meta(wd, "collected_at"),
        "platform": "linux",
        "kernel": meta(wd, "kernel"),
        "arch": meta(wd, "arch"),
        "os_id": meta(wd, "os_id"),
        "os_id_like": meta(wd, "os_id_like"),
        "cpu_cores": meta_int(wd, "cpu_cores"),
        "bios_vendor": meta(wd, "bios_vendor"),
        "bios_version": meta(wd, "bios_version"),
        "firmware": meta(wd, "firmware"),
        "tpm_present": meta(wd, "tpm_present") == "true",
        "selinux": meta(wd, "selinux"),
        "apparmor": meta(wd, "apparmor"),
        "virtualization": meta(wd, "virtualization"),
        "running_in_container": meta(wd, "running_in_container") == "true",
        "system": {"primary_user": meta(wd, "primary_user")},
        "sessions": sessions,
        "network": {
            "adapters": adapters,
            "dns_v4": [x for x in dns if ":" not in x],
            "dns_v6": [x for x in dns if ":" in x],
            "gateways": gateways,
            "primary_ip": meta(wd, "primary_ip"),
        },
        "physical_disks": physical_disks,
        "services": services,
        "patches": patches,
        "secure_boot_enabled": secure_boot,
    }

    bat = meta(wd, "battery_percent")
    if bat is not None:
        try:
            extended["battery"] = {"percent": int(bat)}
        except ValueError:
            pass

    startup = wd / "startup.txt"
    if startup.is_file():
        try:
            txt = startup.read_text(encoding="utf-8", errors="replace")[:8000]
            if txt.strip():
                extended["startup"] = txt
        except OSError:
            pass

    containers = wd / "containers.txt"
    if containers.is_file():
        try:
            txt = containers.read_text(encoding="utf-8", errors="replace")[:4000]
            if txt.strip():
                extended["containers"] = txt
        except OSError:
            pass

    last_logins = wd / "last_logins.txt"
    if last_logins.is_file():
        try:
            txt = last_logins.read_text(encoding="utf-8", errors="replace")[:2000]
            if txt.strip():
                extended["last_logins"] = txt
        except OSError:
            pass

    payload = {
        "hostname": hostname,
        "serial_number": meta(wd, "serial_number"),
        "mac_primary": meta(wd, "mac_primary"),
        "cpu": meta(wd, "cpu"),
        "ram_gb": meta_float(wd, "ram_gb"),
        "os_name": meta(wd, "os_name"),
        "os_version": meta(wd, "os_version"),
        "manufacturer": meta(wd, "manufacturer"),
        "model": meta(wd, "model"),
        "gpu_name": meta(wd, "gpu_name"),
        "memory_used_percent": meta_int(wd, "memory_used_percent"),
        "motherboard_manufacturer": meta(wd, "motherboard_manufacturer"),
        "motherboard_product": meta(wd, "motherboard_product"),
        "disks": disks,
        "software": software,
        "peripherals": peripherals,
        "printers": [],
        "extended": extended,
    }
    return payload


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: emit_report.py WORKDIR [OUT.json]", file=sys.stderr)
        return 2
    wd = Path(sys.argv[1])
    payload = build(wd)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(sys.argv) >= 3:
        Path(sys.argv[2]).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
