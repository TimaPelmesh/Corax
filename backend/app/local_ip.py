"""LAN IPv4 detection for agent bundle defaults and SNMP discovery."""

from __future__ import annotations

import ipaddress
import platform
import re
import socket
import subprocess
from dataclasses import dataclass

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


def _decode_cmd_out(blob: bytes) -> str:
    if platform.system().lower() == "windows":
        for enc in ("cp866", "cp1251", "utf-8"):
            try:
                return blob.decode(enc)
            except UnicodeDecodeError:
                continue
        return blob.decode("utf-8", errors="replace")
    return blob.decode("utf-8", errors="replace")


def _run_text(cmd: list[str], *, timeout: float = 6.0) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return _decode_cmd_out(r.stdout or b"")
    except (OSError, subprocess.TimeoutExpired, TypeError, UnicodeError):
        return ""


def local_ipv4_networks() -> list[ipaddress.IPv4Network]:
    """LAN prefixes from OS (real mask when available), else /24 per local IP."""
    networks: set[ipaddress.IPv4Network] = set()
    win = platform.system().lower() == "windows"
    if win:
        ps = _run_text(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                (
                    "Get-NetIPAddress -AddressFamily IPv4 | "
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
            addr = _private_ipv4(str(iface.ip))
            if not addr:
                continue
            net = iface.network
            if net.prefixlen < 16 or net.prefixlen > 30:
                continue
            networks.add(net)
    else:
        out = _run_text(["ip", "-o", "-4", "addr", "show"])
        # 2: eth0    inet 192.168.1.10/24 ...
        for m in re.finditer(
            r"inet\s+(\d{1,3}(?:\.\d{1,3}){3})/(\d{1,2})",
            out,
        ):
            try:
                iface = ipaddress.ip_interface(f"{m.group(1)}/{m.group(2)}")
            except ValueError:
                continue
            if not isinstance(iface, ipaddress.IPv4Interface):
                continue
            if not _private_ipv4(str(iface.ip)):
                continue
            if 16 <= iface.network.prefixlen <= 30:
                networks.add(iface.network)

    if not networks:
        for addr in local_ipv4_addresses():
            if str(addr).startswith("169.254."):
                continue
            networks.add(ipaddress.ip_network(f"{addr}/24", strict=False))
    return sorted(networks, key=lambda n: (n.prefixlen, int(n.network_address)))


def default_gateway_ipv4() -> list[ipaddress.IPv4Address]:
    """Default IPv4 gateways from the routing table."""
    found: set[ipaddress.IPv4Address] = set()
    win = platform.system().lower() == "windows"
    if win:
        ps = _run_text(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                (
                    "Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | "
                    "Select-Object -ExpandProperty NextHop"
                ),
            ]
        )
        for raw in _IP_RE.findall(ps):
            addr = _private_ipv4(raw)
            if addr:
                found.add(addr)
        route = _run_text(["route", "print", "0.0.0.0"])
        # 0.0.0.0          0.0.0.0      192.168.3.1 ...
        for m in re.finditer(
            r"0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})",
            route,
        ):
            addr = _private_ipv4(m.group(1))
            if addr:
                found.add(addr)
    else:
        out = _run_text(["ip", "route", "show", "default"])
        for m in re.finditer(r"default\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})", out):
            addr = _private_ipv4(m.group(1))
            if addr:
                found.add(addr)
        # Fallback: netstat -rn
        if not found:
            ns = _run_text(["netstat", "-rn"])
            for m in re.finditer(
                r"^(?:default|0\.0\.0\.0)\s+(\d{1,3}(?:\.\d{1,3}){3})",
                ns,
                re.M,
            ):
                addr = _private_ipv4(m.group(1))
                if addr:
                    found.add(addr)
    return sorted(found, key=lambda a: int(a))


def dns_server_ipv4() -> list[ipaddress.IPv4Address]:
    """LAN DNS servers (often the same box as the gateway / router)."""
    found: set[ipaddress.IPv4Address] = set()
    win = platform.system().lower() == "windows"
    if win:
        ps = _run_text(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                (
                    "Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | "
                    "Select-Object -ExpandProperty ServerAddresses"
                ),
            ]
        )
        for raw in _IP_RE.findall(ps):
            addr = _private_ipv4(raw)
            if addr:
                found.add(addr)
    else:
        try:
            with open("/etc/resolv.conf", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except OSError:
            text = ""
        for m in re.finditer(r"nameserver\s+(\d{1,3}(?:\.\d{1,3}){3})", text):
            addr = _private_ipv4(m.group(1))
            if addr:
                found.add(addr)
    return sorted(found, key=lambda a: int(a))


def arp_table_ipv4() -> list[ipaddress.IPv4Address]:
    """IPv4 neighbors from the ARP/neighbor cache (live L2 hosts)."""
    found: set[ipaddress.IPv4Address] = set()
    win = platform.system().lower() == "windows"
    blob = _run_text(["arp", "-a"])
    if win:
        # Internet Address      Physical Address      Type
        # 192.168.3.1           aa-bb-cc-dd-ee-ff     dynamic
        for m in re.finditer(
            r"(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}[-:]){5}[0-9a-f]{2}",
            blob,
            re.I,
        ):
            addr = _private_ipv4(m.group(1))
            if addr:
                found.add(addr)
    else:
        # ip neigh
        neigh = _run_text(["ip", "neigh", "show"])
        text = neigh or blob
        for raw in _IP_RE.findall(text):
            addr = _private_ipv4(raw)
            if addr:
                found.add(addr)
    return sorted(found, key=lambda a: int(a))


def _as_slash24(addr: ipaddress.IPv4Address) -> ipaddress.IPv4Network:
    return ipaddress.ip_network(f"{addr}/24", strict=False)


def _normalize_scan_net(net: ipaddress.IPv4Network) -> list[ipaddress.IPv4Network]:
    """Split wide prefixes into /24 scan units (bounded)."""
    if net.prefixlen > 30 or net.prefixlen < 16:
        return []
    if net.prefixlen >= 24:
        return [net]
    out: list[ipaddress.IPv4Network] = []
    for sub in net.subnets(new_prefix=24):
        out.append(sub)
        if len(out) >= 64:
            break
    return out


def routed_private_networks() -> list[ipaddress.IPv4Network]:
    """Private destination networks from the OS routing table (neighbor VLANs, VPN, etc.)."""
    found: set[ipaddress.IPv4Network] = set()
    win = platform.system().lower() == "windows"
    texts: list[str] = []
    if win:
        # Compact prefixes: "192.168.111.0/24"
        texts.append(
            _run_text(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    (
                        "Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | "
                        "ForEach-Object { $_.DestinationPrefix }"
                    ),
                ],
                timeout=10.0,
            )
        )
        texts.append(_run_text(["route", "print", "-4"], timeout=8.0))
    else:
        texts.append(_run_text(["ip", "-4", "route", "show"]))
        texts.append(_run_text(["ip", "route"]))

    for text in texts:
        for m in re.finditer(r"(\d{1,3}(?:\.\d{1,3}){3})\s*/\s*(\d{1,2})", text):
            try:
                net = ipaddress.ip_network(f"{m.group(1)}/{m.group(2)}", strict=False)
            except ValueError:
                continue
            if isinstance(net, ipaddress.IPv4Network) and net.is_private and 16 <= net.prefixlen <= 30:
                if str(net.network_address).startswith("169.254."):
                    continue
                found.add(net)
        # Windows route print rows: Network Destination  Netmask
        for m in re.finditer(
            r"(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})",
            text,
        ):
            dest, mask, _gw = m.group(1), m.group(2), m.group(3)
            if dest in {"0.0.0.0", "255.255.255.255", "127.0.0.0"}:
                continue
            try:
                net = ipaddress.ip_network(f"{dest}/{mask}", strict=False)
            except ValueError:
                continue
            if isinstance(net, ipaddress.IPv4Network) and net.is_private and 16 <= net.prefixlen <= 30:
                if str(net.network_address).startswith("169.254."):
                    continue
                found.add(net)
    return sorted(found, key=lambda n: (n.prefixlen, int(n.network_address)))


@dataclass(frozen=True)
class CoraxNetworkScope:
    """Auto-detected private networks relative to where CORAX runs."""

    networks: tuple[ipaddress.IPv4Network, ...]
    reasons: tuple[str, ...]  # human-readable why each / related signals
    server_ips: tuple[str, ...]
    gateways: tuple[str, ...]
    arp_hosts: int
    routed_nets: int


def discover_corax_network_scope(*, max_subnets: int = 48) -> CoraxNetworkScope:
    """
    Smart scope: start from CORAX host interfaces, then only add networks
    that the OS actually sees (routes, ARP, gateway, DNS) — no blind ±N guessing.
    """
    reasons: list[str] = []
    networks: set[ipaddress.IPv4Network] = set()
    home: set[ipaddress.IPv4Network] = set()

    server_addrs = [a for a in local_ipv4_addresses() if not str(a).startswith("169.254.")]
    for net in local_ipv4_networks():
        if str(net.network_address).startswith("169.254."):
            continue
        for unit in _normalize_scan_net(net):
            home.add(unit)
            networks.add(unit)
    for addr in server_addrs:
        home.add(_as_slash24(addr))
        networks.add(_as_slash24(addr))
    if home:
        reasons.append(
            "сервер CORAX: " + ", ".join(sorted(str(n) for n in home)[:6])
        )

    gws = default_gateway_ipv4()
    for gw in gws:
        n = _as_slash24(gw)
        networks.add(n)
    if gws:
        reasons.append("шлюз: " + ", ".join(str(g) for g in gws))

    dns = dns_server_ipv4()
    for d in dns:
        networks.add(_as_slash24(d))
    if dns:
        reasons.append("DNS LAN: " + ", ".join(str(d) for d in dns[:4]))

    routed = routed_private_networks()
    routed_added = 0
    for net in routed:
        for unit in _normalize_scan_net(net):
            if unit not in networks:
                routed_added += 1
            networks.add(unit)
    if routed_added:
        reasons.append(f"маршруты ОС → +{routed_added} подсетей")

    # Evidence-based neighbor nets: only /24 with real ARP/neigh activity
    arp = arp_table_ipv4()
    arp_counts: dict[ipaddress.IPv4Network, int] = {}
    for addr in arp:
        n = _as_slash24(addr)
        arp_counts[n] = arp_counts.get(n, 0) + 1
    arp_added = 0
    for n, cnt in sorted(arp_counts.items(), key=lambda kv: (-kv[1], int(kv[0].network_address))):
        if n in home:
            continue
        # Neighbor VLAN/subnet: ≥2 L2 neighbors, or gateway/DNS lives there
        gw_here = any(gw in n for gw in gws)
        dns_here = any(d in n for d in dns)
        if cnt >= 2 or gw_here or dns_here:
            if n not in networks:
                arp_added += 1
            networks.add(n)
    if arp_added:
        reasons.append(f"ARP/соседи L2 → +{arp_added} живых /24")
    if arp:
        reasons.append(f"ARP хостов: {len(arp)}")

    # Cap + stable order: home first, then by ARP density, then address
    def sort_key(n: ipaddress.IPv4Network) -> tuple[int, int, int]:
        is_home = 0 if n in home else 1
        density = -arp_counts.get(n, 0)
        return (is_home, density, int(n.network_address))

    ordered = sorted(networks, key=sort_key)[: max(1, max_subnets)]
    return CoraxNetworkScope(
        networks=tuple(ordered),
        reasons=tuple(reasons),
        server_ips=tuple(str(a) for a in sorted(server_addrs, key=lambda x: int(x))),
        gateways=tuple(str(g) for g in gws),
        arp_hosts=len(arp),
        routed_nets=len(routed),
    )
