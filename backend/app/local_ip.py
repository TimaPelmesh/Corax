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


# docker0 + typical Compose / Docker Desktop pools. 172.16.0.0/16 is often a real office VLAN — keep it.
_DOCKER_BRIDGE_POOLS = tuple(
    ipaddress.ip_network(f"172.{octet}.0.0/16") for octet in range(17, 32)
) + (
    ipaddress.ip_network("192.168.65.0/24"),  # Docker Desktop Linux VM
)


def _is_likely_container_bridge(addr: ipaddress.IPv4Address) -> bool:
    """Docker default/compose bridges — not reachable from LAN PCs."""
    return any(addr in net for net in _DOCKER_BRIDGE_POOLS)


def is_likely_container_network(net: ipaddress.IPv4Network) -> bool:
    """True if this prefix is a Docker/compose/Desktop bridge, not a site LAN."""
    for pool in _DOCKER_BRIDGE_POOLS:
        if net == pool or net.subnet_of(pool):
            return True
    return False


def _lan_sort_key(addr: ipaddress.IPv4Address) -> tuple[int, int]:
    # Prefer real site LANs; demote container bridges so they never win by accident.
    if _is_likely_container_bridge(addr):
        return (9, int(addr))
    s = str(addr)
    if s.startswith("192.168."):
        return (0, int(addr))
    if s.startswith("10."):
        return (1, int(addr))
    if addr in ipaddress.ip_network("172.16.0.0/12"):
        return (2, int(addr))
    return (3, int(addr))


def list_lan_ipv4(*, include_container_bridges: bool = False) -> list[str]:
    addrs = local_ipv4_addresses()
    if not include_container_bridges:
        # Empty is OK — caller must not fall back to Docker bridges for agent URLs.
        addrs = {a for a in addrs if not _is_likely_container_bridge(a)}
    return [str(a) for a in sorted(addrs, key=_lan_sort_key)]


def pick_primary_lan_ipv4() -> str | None:
    """Best site LAN IP for agents. Never returns Docker bridge addresses."""
    items = list_lan_ipv4(include_container_bridges=False)
    return items[0] if items else None


def advertise_lan_ipv4() -> str | None:
    """Preferred agent target: CORAX_ADVERTISE_HOST, else best local LAN IP (not Docker 172.x)."""
    from app.config import settings

    raw = (settings.corax_advertise_host or "").strip()
    if raw:
        # Allow bare IP or host:port / URL scraps
        host = raw.split("://")[-1].split("/")[0].split(":")[0].strip()
        if host:
            return host
    return pick_primary_lan_ipv4()


def parse_cidr_tokens(raw: str | None) -> list[str]:
    if not raw or not str(raw).strip():
        return []
    return [p.strip() for p in re.split(r"[\s,;]+", str(raw).strip()) if p.strip()]


def slash24_from_ip(ip: str | ipaddress.IPv4Address) -> ipaddress.IPv4Network | None:
    host = str(ip).split("/")[0].split(":")[0].strip()
    addr = _private_ipv4(host)
    if not addr or _is_likely_container_bridge(addr):
        return None
    return ipaddress.ip_network(f"{addr}/24", strict=False)


def host_lan_cidrs_for_scan() -> list[str]:
    """Site LAN prefixes of the machine running this code (host during docker:up)."""
    nets: set[ipaddress.IPv4Network] = set()
    for addr in list_lan_ipv4(include_container_bridges=False):
        n = slash24_from_ip(addr)
        if n:
            nets.add(n)
    for net in local_ipv4_networks():
        if is_likely_container_network(net):
            continue
        for unit in _normalize_scan_net(net):
            if not is_likely_container_network(unit):
                nets.add(unit)
    return [str(n) for n in sorted(nets, key=lambda n: int(n.network_address))]


def _env_scan_cidrs() -> list[str]:
    from app.config import settings

    out: list[str] = []
    for raw in (
        getattr(settings, "corax_scan_networks", "") or "",
        getattr(settings, "corax_host_lan_networks", "") or "",
    ):
        out.extend(parse_cidr_tokens(raw))
    adv = advertise_lan_ipv4()
    if adv:
        out.append(adv if "/" in str(adv) else str(adv))
    return out


def _add_scan_units(
    networks: set[ipaddress.IPv4Network],
    net: ipaddress.IPv4Network,
) -> list[ipaddress.IPv4Network]:
    added: list[ipaddress.IPv4Network] = []
    if not isinstance(net, ipaddress.IPv4Network) or not net.is_private:
        return added
    if is_likely_container_network(net):
        return added
    for unit in _normalize_scan_net(net):
        if is_likely_container_network(unit):
            continue
        if unit not in networks:
            networks.add(unit)
            added.append(unit)
    return added


def resolve_lan_scan_networks(
    *,
    cidr_list: list[str] | None = None,
    hint_ips: list[str] | None = None,
    max_subnets: int = 64,
    exclusive: bool = False,
) -> tuple[list[ipaddress.IPv4Network], list[str]]:
    """
    LAN prefixes to SNMP-scan.

    Manual CIDR is added to the auto zone (host LAN, routes, ARP, inventory),
    never a hard cap — otherwise VLANs next to CORAX stay invisible.
    Docker 172.17–31 / 192.168.65 are always dropped.
    exclusive=True scans only the given CIDR list (second-pass neighbor nets).
    """
    reasons: list[str] = []
    networks: set[ipaddress.IPv4Network] = set()

    manual_raw = [c.strip() for c in (cidr_list or []) if c and str(c).strip()]
    if manual_raw:
        for raw in manual_raw:
            try:
                net = ipaddress.ip_network(raw, strict=False)
            except ValueError:
                continue
            if isinstance(net, ipaddress.IPv4Network):
                _add_scan_units(networks, net)
        if networks:
            reasons.append(
                "ручной CIDR: "
                + ", ".join(str(n) for n in sorted(networks, key=lambda n: int(n.network_address))[:12])
            )
            if exclusive:
                ordered = sorted(networks, key=lambda n: int(n.network_address))[: max(1, max_subnets)]
                return ordered, reasons

    if exclusive:
        ordered = sorted(networks, key=lambda n: int(n.network_address))[: max(1, max_subnets)]
        return ordered, reasons or ["пустой список CIDR"]

    env_added: list[str] = []
    for raw in _env_scan_cidrs():
        token = raw.strip()
        net: ipaddress.IPv4Network | None = None
        try:
            net = ipaddress.ip_network(token if "/" in token else f"{token}/24", strict=False)
        except ValueError:
            net = slash24_from_ip(token)
        if net is not None:
            for unit in _add_scan_units(networks, net):
                env_added.append(str(unit))
    if env_added:
        reasons.append("LAN хоста: " + ", ".join(list(dict.fromkeys(env_added))[:8]))

    hint_added: list[str] = []
    for ip in hint_ips or []:
        n = slash24_from_ip(ip)
        if n and n not in networks:
            networks.add(n)
            hint_added.append(str(n))
    if hint_added:
        reasons.append("инвентарь: " + ", ".join(list(dict.fromkeys(hint_added))[:8]))

    scope = discover_corax_network_scope(max_subnets=max(8, max_subnets))
    os_added: list[str] = []
    docker_seen: list[str] = []
    for n in scope.networks:
        if is_likely_container_network(n):
            docker_seen.append(str(n))
            continue
        if n not in networks:
            networks.add(n)
            os_added.append(str(n))
    if os_added:
        reasons.append("интерфейсы ОС: " + ", ".join(os_added[:6]))
    reasons.extend(scope.reasons)
    if docker_seen:
        reasons.append("пропущен Docker-мост: " + ", ".join(list(dict.fromkeys(docker_seen))[:4]))
    if not networks:
        reasons.append(
            "нет LAN для SNMP: процесс в контейнере видит только Docker. "
            "Задайте CIDR в настройках сети, CORAX_ADVERTISE_HOST или "
            "CORAX_HOST_LAN_NETWORKS (подставляется при npm run docker:up)."
        )
        return [], reasons

    ordered = sorted(networks, key=lambda n: int(n.network_address))[: max(1, max_subnets)]
    return ordered, reasons


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


def discover_corax_network_scope(*, max_subnets: int = 64) -> CoraxNetworkScope:
    """
    Smart scope: start from CORAX host interfaces, then only add networks
    that the OS actually sees (routes, ARP, gateway, DNS) — no blind ±N guessing.
    """
    reasons: list[str] = []
    networks: set[ipaddress.IPv4Network] = set()
    home: set[ipaddress.IPv4Network] = set()

    server_addrs = [a for a in local_ipv4_addresses() if not str(a).startswith("169.254.")]
    docker_addrs = [a for a in server_addrs if _is_likely_container_bridge(a)]
    lan_addrs = [a for a in server_addrs if not _is_likely_container_bridge(a)]
    for net in local_ipv4_networks():
        if str(net.network_address).startswith("169.254."):
            continue
        if is_likely_container_network(net):
            continue
        for unit in _normalize_scan_net(net):
            if is_likely_container_network(unit):
                continue
            home.add(unit)
            networks.add(unit)
    for addr in lan_addrs:
        unit = _as_slash24(addr)
        if is_likely_container_network(unit):
            continue
        home.add(unit)
        networks.add(unit)
    if home:
        reasons.append(
            "сервер CORAX: " + ", ".join(sorted(str(n) for n in home)[:6])
        )
    elif docker_addrs:
        reasons.append(
            "сервер CORAX в Docker: " + ", ".join(str(a) for a in docker_addrs[:4])
        )

    gws = [g for g in default_gateway_ipv4() if not _is_likely_container_bridge(g)]
    for gw in gws:
        n = _as_slash24(gw)
        if not is_likely_container_network(n):
            networks.add(n)
    if gws:
        reasons.append("шлюз: " + ", ".join(str(g) for g in gws))

    dns = [d for d in dns_server_ipv4() if not _is_likely_container_bridge(d)]
    for d in dns:
        n = _as_slash24(d)
        if not is_likely_container_network(n):
            networks.add(n)
    if dns:
        reasons.append("DNS LAN: " + ", ".join(str(d) for d in dns[:4]))

    routed = routed_private_networks()
    routed_added = 0
    for net in routed:
        if is_likely_container_network(net):
            continue
        for unit in _normalize_scan_net(net):
            if is_likely_container_network(unit):
                continue
            if unit not in networks:
                routed_added += 1
            networks.add(unit)
    if routed_added:
        reasons.append(f"маршруты ОС → +{routed_added} подсетей")

    # Evidence-based neighbor nets: only /24 with real ARP/neigh activity
    arp = [a for a in arp_table_ipv4() if not _is_likely_container_bridge(a)]
    arp_counts: dict[ipaddress.IPv4Network, int] = {}
    for addr in arp:
        n = _as_slash24(addr)
        if is_likely_container_network(n):
            continue
        arp_counts[n] = arp_counts.get(n, 0) + 1
    arp_added = 0
    for n, cnt in sorted(arp_counts.items(), key=lambda kv: (-kv[1], int(kv[0].network_address))):
        if n in home or is_likely_container_network(n):
            continue
        # Neighbor VLAN/subnet: any ARP/neigh activity, or gateway/DNS lives there
        gw_here = any(gw in n for gw in gws)
        dns_here = any(d in n for d in dns)
        if cnt >= 1 or gw_here or dns_here:
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

    ordered = sorted(networks, key=sort_key)[: max(0, max_subnets)]
    return CoraxNetworkScope(
        networks=tuple(ordered),
        reasons=tuple(reasons),
        server_ips=tuple(str(a) for a in sorted(server_addrs, key=lambda x: int(x))),
        gateways=tuple(str(g) for g in gws),
        arp_hosts=len(arp),
        routed_nets=len(routed),
    )
