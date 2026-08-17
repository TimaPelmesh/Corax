"""Resolve last-known IPv4 for a PC (agent payload, hostname DNS, ARP by MAC)."""

from __future__ import annotations

import ipaddress
import json
import platform
import re
import socket
import subprocess
from typing import Any


def _usable_ipv4(raw: str | None) -> str | None:
    """Accept unicast IPv4 for ICMP; skip loopback / link-local / multicast."""
    s = (raw or "").strip()
    if not s:
        return None
    try:
        addr = ipaddress.ip_address(s)
    except ValueError:
        return None
    if not isinstance(addr, ipaddress.IPv4Address):
        return None
    if addr.is_loopback or addr.is_link_local or addr.is_unspecified or addr.is_multicast:
        return None
    return str(addr)


def _as_ip_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace(";", ",").split(",")]
        return [p for p in parts if p]
    if isinstance(raw, (list, tuple)):
        out: list[str] = []
        for x in raw:
            if isinstance(x, str):
                out.extend(_as_ip_list(x))
            elif x is not None:
                out.append(str(x))
        return out
    return [str(raw)]


def _norm_mac(raw: str | None) -> str | None:
    if not raw:
        return None
    hex_only = re.sub(r"[^0-9a-fA-F]", "", raw)
    if len(hex_only) != 12:
        return None
    return hex_only.lower()


def primary_ipv4_from_extended(
    ext: dict[str, Any] | None,
    *,
    prefer_mac: str | None = None,
) -> str | None:
    if not ext:
        return None
    net = ext.get("network")
    if not isinstance(net, dict):
        return None

    adapters = net.get("adapters")
    if not isinstance(adapters, list):
        adapters = []

    prefer = _norm_mac(prefer_mac)
    ranked: list[tuple[int, int, int, int, str]] = []

    for ad in adapters:
        if not isinstance(ad, dict):
            continue
        ips = _as_ip_list(ad.get("ipv4") or ad.get("ip") or ad.get("ip_address"))
        gw_raw = ad.get("gateway")
        if isinstance(gw_raw, list):
            gw = " ".join(str(x) for x in gw_raw if x)
        else:
            gw = str(gw_raw or "")
        has_gw = 0 if gw.strip() else 1
        status = str(ad.get("status") or "").lower()
        status_rank = 0 if status in ("up", "connected") else 1
        ad_mac = _norm_mac(
            str(ad.get("mac_address") or ad.get("mac") or ad.get("MacAddress") or "")
        )
        mac_rank = 0 if (prefer and ad_mac and ad_mac == prefer) else 1

        for raw in ips:
            ip = _usable_ipv4(raw)
            if not ip:
                continue
            try:
                priv = 0 if ipaddress.ip_address(ip).is_private else 1
            except ValueError:
                priv = 1
            ranked.append((mac_rank, priv, status_rank, has_gw, ip))

    if ranked:
        ranked.sort(key=lambda x: (x[0], x[1], x[2], x[3]))
        return ranked[0][4]

    for key in ("ipv4", "ip_addresses", "ips"):
        for raw in _as_ip_list(net.get(key)):
            ip = _usable_ipv4(raw)
            if ip:
                return ip
    return None


def primary_ipv4_from_raw_payload(
    raw: str | None,
    *,
    prefer_mac: str | None = None,
) -> str | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    top = _usable_ipv4(str(data.get("ip_address")) if data.get("ip_address") else None)
    if top:
        return top
    # Sometimes agents put a short list at top level
    for raw_ip in _as_ip_list(data.get("ipv4") or data.get("ips")):
        ip = _usable_ipv4(raw_ip)
        if ip:
            return ip
    ext = data.get("extended")
    return primary_ipv4_from_extended(
        ext if isinstance(ext, dict) else None,
        prefer_mac=prefer_mac or (str(data.get("mac_primary")) if data.get("mac_primary") else None),
    )


def ipv4_from_hostname(hostname: str | None) -> str | None:
    """LAN DNS / NetBIOS-style resolve of inventory hostname."""
    hn = (hostname or "").strip().rstrip(".")
    if not hn or hn in (".", "localhost"):
        return None
    try:
        infos = socket.getaddrinfo(hn, None, family=socket.AF_INET, type=socket.SOCK_STREAM)
    except OSError:
        # Try short name / FQDN variants lightly
        if "." in hn:
            short = hn.split(".", 1)[0]
            try:
                infos = socket.getaddrinfo(short, None, family=socket.AF_INET, type=socket.SOCK_STREAM)
            except OSError:
                return None
        else:
            return None
    for info in infos:
        ip = _usable_ipv4(info[4][0])
        if ip:
            return ip
    return None


def ipv4_from_arp_mac(mac: str | None) -> str | None:
    """Best-effort: find IP for MAC in local ARP table (same L2 as CORAX host)."""
    want = _norm_mac(mac)
    if not want:
        return None
    win = platform.system().lower() == "windows"
    try:
        r = subprocess.run(
            ["arp", "-a"] if win else ["arp", "-an"],
            capture_output=True,
            timeout=4,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (r.stdout or b"").decode("utf-8", errors="replace")
    if win and not text.strip():
        text = (r.stdout or b"").decode("cp866", errors="replace")

    # 192.168.1.10           aa-bb-cc-dd-ee-ff     dynamic
    # ? (192.168.1.10) at aa:bb:cc:dd:ee:ff ...
    for line in text.splitlines():
        macs = re.findall(r"(?:[0-9a-fA-F]{2}[-:]){5}[0-9a-fA-F]{2}", line)
        ips = re.findall(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", line)
        for m in macs:
            if _norm_mac(m) != want:
                continue
            for ip_raw in ips:
                ip = _usable_ipv4(ip_raw)
                if ip:
                    return ip
    return None


def resolve_computer_ipv4(
    *,
    ip_address: str | None = None,
    hostname: str | None = None,
    mac_primary: str | None = None,
    raw_payload: str | None = None,
) -> str | None:
    """
    Resolve ping target IP without inventing data:
    1) stored ip_address
    2) agent payload (prefer adapter with mac_primary)
    3) DNS for hostname
    4) ARP table by MAC (if CORAX shares L2 with the PC)
    """
    stored = _usable_ipv4(ip_address)
    if stored:
        return stored

    from_payload = primary_ipv4_from_raw_payload(raw_payload, prefer_mac=mac_primary)
    if from_payload:
        return from_payload

    from_dns = ipv4_from_hostname(hostname)
    if from_dns:
        return from_dns

    return ipv4_from_arp_mac(mac_primary)
