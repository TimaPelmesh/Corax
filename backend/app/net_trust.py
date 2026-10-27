"""Trusted-proxy and URL allowlists. Empty TRUSTED_PROXY_IPS → ignore XFF/SSO/proto."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

from app.config import settings

_DOCKERISH_NETS = (
    ipaddress.ip_network("172.17.0.0/16"),
    ipaddress.ip_network("172.18.0.0/16"),
    ipaddress.ip_network("192.168.65.0/24"),
)

_METADATA_NETS = (
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("fd00:ec2::/32"),
)


def normalize_ip(raw: str | None) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None
    if s.startswith("[") and "]" in s:
        s = s[1 : s.index("]")]
    if "%" in s:
        s = s.split("%", 1)[0]
    try:
        addr = ipaddress.ip_address(s)
    except ValueError:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return str(addr)


def _parse_networks(raw: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    out: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for part in (raw or "").replace(";", ",").split(","):
        item = part.strip()
        if not item:
            continue
        try:
            if "/" in item:
                out.append(ipaddress.ip_network(item, strict=False))
            else:
                addr = ipaddress.ip_address(item)
                out.append(ipaddress.ip_network(f"{addr}/{addr.max_prefixlen}"))
        except ValueError:
            continue
    return out


def trusted_proxy_networks() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    return _parse_networks(getattr(settings, "trusted_proxy_ips", "") or "")


def is_trusted_proxy(ip: str | None) -> bool:
    parsed = normalize_ip(ip)
    if not parsed:
        return False
    addr = ipaddress.ip_address(parsed)
    return any(addr in net for net in trusted_proxy_networks())


def is_dockerish_ip(ip: str | None) -> bool:
    parsed = normalize_ip(ip)
    if not parsed:
        return True
    addr = ipaddress.ip_address(parsed)
    if addr.is_loopback or addr.is_link_local or addr.is_unspecified:
        return True
    return any(addr in net for net in _DOCKERISH_NETS)


def is_private_ip(ip: str | None) -> bool:
    parsed = normalize_ip(ip)
    if not parsed:
        return False
    try:
        return ipaddress.ip_address(parsed).is_private
    except ValueError:
        return False


def client_ip_from_parts(
    peer: str | None,
    forwarded_for: str | None,
    real_ip: str | None,
    *,
    trust_forwarded: bool | None = None,
) -> str:
    peer_ip = normalize_ip(peer) or (peer or "").strip()
    trust = is_trusted_proxy(peer_ip) if trust_forwarded is None else bool(trust_forwarded)
    if not trust:
        return peer_ip
    candidates: list[str] = []
    for item in (forwarded_for or "").split(","):
        got = normalize_ip(item)
        if got:
            candidates.append(got)
    real = normalize_ip(real_ip)
    if real:
        candidates.append(real)
    if peer_ip:
        candidates.append(peer_ip)
    for ip in candidates:
        addr = ipaddress.ip_address(ip)
        if addr.is_private and not addr.is_loopback and not addr.is_link_local:
            return ip
    return candidates[0] if candidates else ""


def request_is_https(scheme: str | None, forwarded_proto: str | None, peer: str | None) -> bool:
    if (scheme or "").strip().lower() == "https":
        return True
    if not is_trusted_proxy(peer):
        return False
    return (forwarded_proto or "").strip().lower() == "https"


def _host_allowed_by_settings(host: str) -> bool:
    extra = (getattr(settings, "llm_allow_hosts", "") or "").replace(";", ",")
    allowed = {h.strip().lower() for h in extra.split(",") if h.strip()}
    configured = (settings.lm_studio_base_url or "").strip()
    if configured:
        try:
            cfg_host = (urlparse(configured).hostname or "").strip().lower()
            if cfg_host:
                allowed.add(cfg_host)
        except ValueError:
            pass
    return host.lower() in allowed


def llm_url_allowed(raw: str | None) -> bool:
    """Local/private LLM endpoints only, unless LLM_ALLOW_PUBLIC_URL=true."""
    if bool(getattr(settings, "llm_allow_public_url", False)):
        return True
    base = (raw or "").strip()
    if not base:
        return True
    try:
        parsed = urlparse(base)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").strip().lower()
    if not host:
        return False
    if host in {"localhost", "host.docker.internal", "host.containers.internal"}:
        return True
    if host.endswith(".local") or host.endswith(".lan"):
        return True
    if _host_allowed_by_settings(host):
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except OSError:
            return False
        addrs = []
        for info in infos:
            try:
                addrs.append(ipaddress.ip_address(info[4][0]))
            except (ValueError, TypeError, IndexError):
                continue
        if not addrs:
            return False
        if any(a in net for a in addrs for net in _METADATA_NETS):
            return False
        return all(a.is_private or a.is_loopback for a in addrs)
    if any(addr in net for net in _METADATA_NETS):
        return False
    return bool(addr.is_private or addr.is_loopback)
