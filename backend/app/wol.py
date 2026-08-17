"""Wake-on-LAN helpers for CORAX panel (no secrets; MAC from DB only)."""

from __future__ import annotations

import ipaddress
import platform
import re
import socket
import subprocess
import time

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


def local_lan_interfaces() -> list[tuple[str, ipaddress.IPv4Network]]:
    """Physical/site LAN NICs only — skip Docker bridge pools (useless for WoL to PCs)."""
    from app.local_ip import _is_likely_container_bridge

    found: dict[str, ipaddress.IPv4Network] = {}
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
                    "ForEach-Object { \"$($_.IPAddress)/$($_.PrefixLength)\" }"
                ),
            ]
        )
        for line in ps.splitlines():
            raw = line.strip()
            if "/" not in raw:
                continue
            try:
                iface = ipaddress.ip_interface(raw)
            except ValueError:
                continue
            if not isinstance(iface, ipaddress.IPv4Interface):
                continue
            if not _private_ipv4(str(iface.ip)):
                continue
            if _is_likely_container_bridge(iface.ip):
                continue
            if 16 <= iface.network.prefixlen <= 30:
                found[str(iface.ip)] = iface.network
    else:
        out = _run_text(["ip", "-o", "-4", "addr", "show"])
        for m in re.finditer(r"inet\s+(\d{1,3}(?:\.\d{1,3}){3})/(\d{1,2})", out):
            try:
                iface = ipaddress.ip_interface(f"{m.group(1)}/{m.group(2)}")
            except ValueError:
                continue
            if not isinstance(iface, ipaddress.IPv4Interface):
                continue
            if not _private_ipv4(str(iface.ip)):
                continue
            if _is_likely_container_bridge(iface.ip):
                continue
            if 16 <= iface.network.prefixlen <= 30:
                found[str(iface.ip)] = iface.network
    return sorted(found.items(), key=lambda x: int(ipaddress.ip_address(x[0])))


def _send_one(packet: bytes, *, local_ip: str, bcast: str, port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        if local_ip:
            sock.bind((local_ip, 0))
        sock.sendto(packet, (bcast, int(port)))


def send_wake(
    mac: bytes,
    *,
    count: int = 30,
    delay_ms: int = 20,
) -> dict[str, int]:
    """Send magic packets from each LAN NIC. Returns {sent, errors}.

    ``count`` is the number of UDP datagrams (default 30). Destinations cycle across
    subnet broadcast + 255.255.255.255 and ports 9/7 so flaky NICs still hear a wake.
    """
    packet = build_magic_packet(mac)
    interfaces = local_lan_interfaces()
    routes: list[tuple[str, str]] = []
    if interfaces:
        for local_ip, net in interfaces:
            routes.append((local_ip, str(net.broadcast_address)))
            routes.append((local_ip, "255.255.255.255"))
    else:
        routes.append(("", "255.255.255.255"))

    targets: list[tuple[str, str, int]] = [
        (lip, bcast, port) for lip, bcast in routes for port in _DEFAULT_PORTS
    ]
    if not targets:
        targets = [("", "255.255.255.255", 9)]

    sent = 0
    errors = 0
    n = max(1, min(int(count), 64))
    for i in range(n):
        local_ip, bcast, port = targets[i % len(targets)]
        try:
            _send_one(packet, local_ip=local_ip, bcast=bcast, port=port)
            sent += 1
        except OSError:
            errors += 1
        if delay_ms > 0 and i + 1 < n:
            time.sleep(delay_ms / 1000.0)
    return {"sent": sent, "errors": errors}
