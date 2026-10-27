"""Identify the employee PC / LDAP account for the public /h form."""

from __future__ import annotations

import base64
import socket
from typing import Iterable

from fastapi import Request

from app.net_trust import (
    client_ip_from_parts,
    is_dockerish_ip,
    is_private_ip,
    is_trusted_proxy,
    normalize_ip,
)

_SSO_HEADERS = (
    "remote-user",
    "x-remote-user",
    "x-forwarded-user",
    "x-authenticated-user",
)

__all__ = [
    "client_ip",
    "client_ip_from_parts",
    "is_dockerish_ip",
    "is_private_ip",
    "normalize_ip",
    "ntlm_type3_username",
    "sam_account",
    "sso_login",
    "sso_login_from_headers",
    "reverse_dns_shortname",
]


def sam_account(raw: str | None) -> str | None:
    s = (raw or "").strip().strip('"').strip("'")
    if not s:
        return None
    lower = s.lower()
    for prefix in ("negotiate ", "ntlm ", "basic "):
        if lower.startswith(prefix):
            return None
    if "\\" in s:
        s = s.rsplit("\\", 1)[-1]
    if "/" in s:
        s = s.rsplit("/", 1)[-1]
    if "@" in s:
        s = s.split("@", 1)[0]
    s = s.strip()
    return s or None


def ntlm_type3_username(authorization: str | None) -> str | None:
    """Best-effort username from an NTLM Type 3 blob (no password check)."""
    raw_header = (authorization or "").strip()
    if not raw_header:
        return None
    parts = raw_header.split(None, 1)
    if len(parts) != 2:
        return None
    scheme, token = parts[0].lower(), parts[1].strip()
    if scheme not in {"ntlm", "negotiate"}:
        return None
    try:
        blob = base64.b64decode(token)
    except (ValueError, TypeError):
        return None
    if len(blob) < 64 or blob[:7] != b"NTLMSSP":
        return None
    msg_type = int.from_bytes(blob[8:12], "little")
    if msg_type != 3:
        return None
    ulen = int.from_bytes(blob[36:38], "little")
    uoff = int.from_bytes(blob[40:44], "little")
    if ulen == 0 or ulen > 512 or uoff + ulen > len(blob):
        return None
    name_bytes = blob[uoff : uoff + ulen]
    try:
        name = name_bytes.decode("utf-16-le").strip("\x00").strip()
    except UnicodeDecodeError:
        name = name_bytes.decode("utf-8", errors="ignore").strip()
    return sam_account(name)


def client_ip(request: Request) -> str:
    peer = (request.client.host if request.client else "") or ""
    return client_ip_from_parts(
        peer,
        request.headers.get("x-forwarded-for"),
        request.headers.get("x-real-ip"),
    )


def sso_login_from_headers(headers: Iterable[tuple[str, str]]) -> str | None:
    mapping = {str(k).lower(): v for k, v in headers}
    for key in _SSO_HEADERS:
        got = sam_account(mapping.get(key))
        if got:
            return got
    return ntlm_type3_username(mapping.get("authorization"))


def sso_login(request: Request) -> str | None:
    peer = (request.client.host if request.client else "") or ""
    if not is_trusted_proxy(peer):
        return None
    return sso_login_from_headers(request.headers.items())


def reverse_dns_shortname(ip: str, timeout_sec: float = 0.35) -> str | None:
    parsed = normalize_ip(ip)
    if not parsed or is_dockerish_ip(parsed):
        return None
    prev = socket.getdefaulttimeout()
    socket.setdefaulttimeout(timeout_sec)
    try:
        host, _, _ = socket.gethostbyaddr(parsed)
    except OSError:
        return None
    finally:
        socket.setdefaulttimeout(prev)
    name = (host or "").strip().rstrip(".")
    if not name:
        return None
    return name
