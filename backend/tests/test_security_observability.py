"""Security headers + observability smoke tests."""
from __future__ import annotations


def test_security_headers_present(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "DENY"
    assert r.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"
    assert "Permissions-Policy" in r.headers
    assert r.headers.get("X-Request-Id")


def test_request_id_echo(client):
    r = client.get("/api/v1/health", headers={"X-Request-Id": "test-rid-abc123"})
    assert r.status_code == 200
    assert r.headers.get("X-Request-Id") == "test-rid-abc123"


def test_login_json_default_hides_token(client):
    """Without return_token, body must not expose JWT (cookie auth path)."""
    r = client.post(
        "/api/v1/auth/login/json",
        json={"username": "admin", "password": "admin123"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("access_token") in ("", None) or body.get("access_token") == ""
    assert "access_token" in r.cookies or any(c.lower() == "access_token" for c in r.cookies.keys())
