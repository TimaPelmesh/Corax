"""LAN IPv4 detection for agent bundle defaults and SNMP discovery."""

from __future__ import annotations

import ipaddress
import platform
import re
import socket
import subprocess

_IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


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
        or int(addr) >= int(ipaddress.ip_address("224.0.0.0"))
    ):
        return None
    return addr


def local_ipv4_addresses() -> set[ipaddress.IPv4Address]:
    out: set[ipaddress.IPv4Address] = set()
    try:
        for raw in socket.gethostbyname_ex(socket.gethostname())[2]:
            addr = _private_ipv4(raw)
            if addr:
                out.add(addr)
    except OSError:
        pass

    commands = (
        [
            ["ipconfig"],
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress",
            ],
        ]
        if platform.system().lower() == "windows"
        else [["ip", "-o", "-4", "addr", "show"], ["hostname", "-I"]]
    )
    for cmd in commands:
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=5)
            blob = r.stdout or b""
            if platform.system().lower() == "windows":
                stdout = ""
                for enc in ("cp866", "cp1251", "utf-8"):
                    try:
                        stdout = blob.decode(enc)
                        break
                    except UnicodeDecodeError:
                        continue
                if not stdout:
                    stdout = blob.decode("utf-8", errors="replace")
            else:
                stdout = blob.decode("utf-8", errors="replace")
            for raw in _IP_RE.findall(stdout):
                addr = _private_ipv4(raw)
                if addr:
                    out.add(addr)
        except (OSError, subprocess.TimeoutExpired, TypeError, UnicodeError):
            continue
    return out


def _lan_sort_key(addr: ipaddress.IPv4Address) -> tuple[int, int]:
    s = str(addr)
    if s.startswith("192.168."):
        return (0, int(addr))
    if s.startswith("10."):
        return (1, int(addr))
    if addr in ipaddress.ip_network("172.16.0.0/12"):
        return (2, int(addr))
    return (3, int(addr))


def list_lan_ipv4() -> list[str]:
    return [str(a) for a in sorted(local_ipv4_addresses(), key=_lan_sort_key)]


def pick_primary_lan_ipv4() -> str | None:
    items = list_lan_ipv4()
    return items[0] if items else None
