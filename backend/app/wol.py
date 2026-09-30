"""Wake-on-LAN helpers for CORAX panel (no secrets; MAC from DB only)."""

from __future__ import annotations

import ipaddress
import json
import os
import platform
import re
import socket
import subprocess
import time
import uuid
from pathlib import Path

_DEFAULT_PORTS = (9, 7)


def normalize_mac(raw: str | None) -> bytes:
    s = (raw or "").strip()
    if re.fullmatch(r"[0-9a-fA-F]{4}(\.[0-9a-fA-F]{4}){2}", s):
        s = s.replace(".", "")
    hex_only = re.sub(r"[^0-9a-fA-F]", "", s)
    if len(hex_only) != 12:
        raise ValueError("invalid_mac")
    mac = bytes.fromhex(hex_only)
    if mac in (b"\x00" * 6, b"\xff" * 6) or (mac[0] & 0x01):
        raise ValueError("invalid_mac")
    return mac


def format_mac(mac: bytes) -> str:
    return ":".join(f"{b:02X}" for b in mac)


def build_magic_packet(mac: bytes) -> bytes:
    return b"\xff" * 6 + mac * 16


def _decode_cmd(blob: bytes) -> str:
    if platform.system().lower() == "windows":
        for enc in ("cp866", "cp1251", "utf-8"):
            try:
                return blob.decode(enc)
            except UnicodeDecodeError:
                continue
        return blob.decode("utf-8", errors="replace")
    return blob.decode("utf-8", errors="replace")


def _run_text(cmd: list[str], *, timeout: float = 5.0) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return _decode_cmd(r.stdout or b"")
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _private_ipv4(ip: str) -> ipaddress.IPv4Address | None:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if not isinstance(addr, ipaddress.IPv4Address):
        return None
    if (
        not addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_unspecified
        or addr.is_multicast
    ):
        return None
    return addr


_VIRTUAL_IFACE = re.compile(
    r"vethernet|wsl|hyper-?v|docker|virtualbox|vbox|bluetooth|loopback|"
    r"tap-windows|vpn|zerotier|tailscale|hamachi|npcap|virbr|\bbr-|\bveth|"
    r"vmware|virtual|pseudo|isatap|teredo",
    re.I,
)


def iface_is_virtual(name: str) -> bool:
    return bool(_VIRTUAL_IFACE.search(name or ""))


def interfaces_from_ipconfig(text: str) -> list[tuple[str, str, ipaddress.IPv4Network]]:
    """Parse Windows ipconfig into (alias, ip, network), skipping virtual adapters."""
    found: list[tuple[str, str, ipaddress.IPv4Network]] = []
    alias = ""
    ip = ""
    mask = ""

    def flush() -> None:
        nonlocal ip, mask
        if alias and ip and mask and not iface_is_virtual(alias):
            addr = _private_ipv4(ip)
            if addr is not None:
                try:
                    iface = ipaddress.ip_interface(f"{ip}/{mask}")
                except ValueError:
                    iface = None
                if isinstance(iface, ipaddress.IPv4Interface) and 8 <= iface.network.prefixlen <= 30:
                    from app.local_ip import _is_likely_container_bridge

                    if not _is_likely_container_bridge(addr):
                        found.append((alias, ip, iface.network))
        ip = ""
        mask = ""

    ipv4_re = re.compile(
        r"(?:IPv4[^:\n]*|IP[- ]?Address[^:\n]*)\s*:\s*(\d{1,3}(?:\.\d{1,3}){3})",
        re.I,
    )
    mask_re = re.compile(
        r"(?:Subnet Mask|Маска подсети)[^:\n]*:\s*(\d{1,3}(?:\.\d{1,3}){3})",
        re.I,
    )
    for raw in text.splitlines():
        if raw and not raw[:1].isspace():
            flush()
            alias = raw.strip().rstrip(":")
            continue
        m_ip = ipv4_re.search(raw)
        if m_ip:
            ip = m_ip.group(1)
        m_mask = mask_re.search(raw)
        if m_mask:
            mask = m_mask.group(1)
    flush()
    return found


def local_lan_interfaces() -> list[tuple[str, ipaddress.IPv4Network]]:
    """Physical/site LAN NICs only — skip Docker, WSL, Hyper-V and VPN adapters."""
    from app.local_ip import _is_likely_container_bridge

    found: dict[str, ipaddress.IPv4Network] = {}

    def keep(alias: str, ip: str, prefixlen: int) -> None:
        if iface_is_virtual(alias):
            return
        if not (8 <= prefixlen <= 30):
            return
        addr = _private_ipv4(ip)
        if addr is None or _is_likely_container_bridge(addr):
            return
        try:
            iface = ipaddress.ip_interface(f"{ip}/{prefixlen}")
        except ValueError:
            return
        if isinstance(iface, ipaddress.IPv4Interface):
            found[str(iface.ip)] = iface.network

    win = platform.system().lower() == "windows"
    if win:
        ps = _run_text(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                (
                    "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | "
                    "Where-Object { $_.IPAddress -and $_.PrefixLength } | "
                    "ForEach-Object { \"$($_.InterfaceAlias)|$($_.IPAddress)/$($_.PrefixLength)\" }"
                ),
            ]
        )
        for line in ps.splitlines():
            raw = line.strip()
            if "|" not in raw or "/" not in raw:
                continue
            alias, cidr = raw.split("|", 1)
            ip, _, plen = cidr.partition("/")
            try:
                keep(alias.strip(), ip.strip(), int(plen))
            except ValueError:
                continue
        if not found:
            for alias, ip, net in interfaces_from_ipconfig(_run_text(["ipconfig"])):
                found[ip] = net
    else:
        out = _run_text(["ip", "-o", "-4", "addr", "show"])
        for line in out.splitlines():
            m = re.search(r"^\d+:\s+(\S+).*?\binet\s+(\d{1,3}(?:\.\d{1,3}){3})/(\d{1,2})", line)
            if not m:
                m = re.search(r"inet\s+(\d{1,3}(?:\.\d{1,3}){3})/(\d{1,2})", line)
                if not m:
                    continue
                alias, ip, plen = "", m.group(1), m.group(2)
            else:
                alias, ip, plen = m.group(1), m.group(2), m.group(3)
            try:
                keep(alias, ip, int(plen))
            except ValueError:
                continue
    return sorted(found.items(), key=lambda x: int(ipaddress.ip_address(x[0])))


def _send_one(packet: bytes, *, local_ip: str, bcast: str, port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        if local_ip:
            sock.bind((local_ip, 0))
        sock.sendto(packet, (bcast, int(port)))


def _usable_target_ip(raw: str | None) -> str:
    addr = _private_ipv4((raw or "").strip())
    return str(addr) if addr is not None else ""


def _in_docker() -> bool:
    return os.environ.get("CORAX_DOCKER", "").strip().lower() in {"1", "true", "yes"}


def send_wake_local(
    mac: bytes,
    *,
    target_ip: str | None = None,
    count: int = 24,
    delay_ms: int = 15,
) -> dict[str, int | str]:
    """Send magic packets from each physical LAN NIC. Returns {sent, errors}."""
    packet = build_magic_packet(mac)
    interfaces = local_lan_interfaces()
    host = _usable_target_ip(target_ip)
    routes: list[tuple[str, str]] = []
    if interfaces:
        for local_ip, net in interfaces:
            bcast = str(net.broadcast_address)
            routes.append((local_ip, bcast))
            routes.append((local_ip, bcast))
            routes.append((local_ip, "255.255.255.255"))
            if host:
                try:
                    if ipaddress.ip_address(host) in net:
                        routes.append((local_ip, host))
                except ValueError:
                    pass
        if host and not any(dest == host for _, dest in routes):
            routes.append((interfaces[0][0], host))
    else:
        routes.append(("", "255.255.255.255"))
        if host:
            routes.append(("", host))

    targets: list[tuple[str, str, int]] = [
        (lip, dest, port) for lip, dest in routes for port in _DEFAULT_PORTS
    ]
    if not targets:
        targets = [("", "255.255.255.255", 9)]

    sent = 0
    errors = 0
    n = max(1, min(int(count), 64))
    for i in range(n):
        local_ip, dest, port = targets[i % len(targets)]
        try:
            _send_one(packet, local_ip=local_ip, bcast=dest, port=port)
            sent += 1
        except OSError:
            errors += 1
        if delay_ms > 0 and i + 1 < n:
            time.sleep(delay_ms / 1000.0)
    return {"sent": sent, "errors": errors, "detail": ""}


def _send_via_queue(
    mac: bytes,
    *,
    target_ip: str | None,
    queue_dir: str,
) -> dict[str, int | str]:
    """Ask the host process to emit the packet. A container bridge cannot."""
    token = os.environ.get("CORAX_WOL_RELAY_TOKEN", "").strip()
    if not token:
        return {"sent": 0, "errors": 1, "detail": "no_token"}
    root = Path(queue_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        return {"sent": 0, "errors": 1, "detail": "relay_timeout"}
    uid = uuid.uuid4().hex
    req = root / f"req-{uid}.json"
    tmp = root / f"req-{uid}.json.tmp"
    res = root / f"res-{uid}.json"
    body = json.dumps(
        {"token": token, "mac": format_mac(mac), "ip": _usable_target_ip(target_ip)},
        ensure_ascii=False,
    )
    try:
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(req)
    except OSError:
        return {"sent": 0, "errors": 1, "detail": "relay_timeout"}
    deadline = time.time() + 4.0
    try:
        while time.time() < deadline:
            if res.is_file():
                try:
                    data = json.loads(res.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    data = {}
                res.unlink(missing_ok=True)
                req.unlink(missing_ok=True)
                return {
                    "sent": int(data.get("sent") or 0),
                    "errors": int(data.get("errors") or 0),
                    "detail": str(data.get("detail") or ""),
                }
            time.sleep(0.05)
    finally:
        req.unlink(missing_ok=True)
        tmp.unlink(missing_ok=True)
    return {"sent": 0, "errors": 1, "detail": "relay_timeout"}


def send_wake(
    mac: bytes,
    *,
    target_ip: str | None = None,
    count: int = 24,
    delay_ms: int = 15,
) -> dict[str, int | str]:
    """Send a magic packet on the LAN.

    Inside Docker the UDP broadcast never leaves the bridge, so the panel writes
    a request and the host relay (started by ``npm run docker:up``) sends it
    from the real NIC — the same path as a working local script.
    """
    queue = os.environ.get("CORAX_WOL_QUEUE_DIR", "").strip()
    if queue:
        return _send_via_queue(mac, target_ip=target_ip, queue_dir=queue)
    if _in_docker():
        return {"sent": 0, "errors": 1, "detail": "docker_no_relay"}
    return send_wake_local(mac, target_ip=target_ip, count=count, delay_ms=delay_ms)
