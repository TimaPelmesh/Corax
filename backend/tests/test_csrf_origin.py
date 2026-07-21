"""CSRF same-origin helper (no DB)."""
from __future__ import annotations

from starlette.datastructures import Headers
from starlette.requests import Request


def _make_request(*, host: str, scheme: str = "http") -> Request:
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": scheme,
        "path": "/api/v1/computers",
        "raw_path": b"/api/v1/computers",
        "query_string": b"",
        "headers": Headers({"host": host}).raw,
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 3000),
    }
    return Request(scope)


def test_csrf_same_origin_lan_ip_allowed():
    from app.main import _csrf_origin_allowed

    req = _make_request(host="192.168.1.50:3000")
    assert _csrf_origin_allowed("http://192.168.1.50:3000", req) is True


def test_csrf_evil_origin_rejected():
    from app.main import _csrf_origin_allowed

    req = _make_request(host="192.168.1.50:3000")
    assert _csrf_origin_allowed("http://evil.example", req) is False
    # listed in default CORS_ORIGINS
    assert _csrf_origin_allowed("http://localhost:3000", req) is True
