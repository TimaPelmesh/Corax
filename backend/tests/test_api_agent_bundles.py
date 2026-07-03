from __future__ import annotations

import io
import zipfile

from starlette.testclient import TestClient


def test_lan_ip_requires_superuser(client: TestClient):
    client.cookies.clear()
    r = client.get("/api/v1/agent-bundles/lan-ip")
    assert r.status_code == 401


def test_lan_ip_ok(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/agent-bundles/lan-ip", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert "candidates" in body


def test_create_agent_bundle_zip(client: TestClient, auth_headers: dict[str, str]):
    r = client.post(
        "/api/v1/agent-bundles",
        headers=auth_headers,
        json={
            "server_url": "http://192.168.1.10:3001",
            "create_token": False,
            "existing_token": "test-token-for-api-bundle",
            "target": "win10",
            "profile": "full",
        },
    )
    assert r.status_code == 200
    assert "zip" in r.headers.get("content-type", "").lower()
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        names = zf.namelist()
        assert "corax_send.bat" in names
        assert "agent_env.bat" in names
