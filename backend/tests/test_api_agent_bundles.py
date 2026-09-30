from __future__ import annotations

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


def _assert_personal_exe(r, server: str, token: str) -> None:
    assert r.status_code == 200, r.text
    assert "portable-executable" in r.headers.get("content-type", "").lower()
    assert r.content[:2] == b"MZ"
    disposition = r.headers.get("content-disposition", "")
    assert "CORAX-Agent.exe" in disposition
    assert server.encode() in r.content
    assert token.encode() in r.content
    assert b"agent.provision.json" not in r.content


def test_create_agent_bundle_zip(client: TestClient, auth_headers: dict[str, str]):
    token = "test-token-for-api-bundle"
    r = client.post(
        "/api/v1/agent-bundles",
        headers=auth_headers,
        json={
            "server_url": "http://192.168.1.10:3001",
            "create_token": False,
            "existing_token": token,
            "target": "win10",
            "profile": "full",
        },
    )
    _assert_personal_exe(r, "http://192.168.1.10:3001", token)


def test_create_native_agent_is_portable_zip_with_unmodified_exe(
    client: TestClient, auth_headers: dict[str, str]
):
    token = "portable-test.secret-value"
    r = client.post(
        "/api/v1/agent-bundles",
        headers=auth_headers,
        json={
            "server_url": "https://corax.lan:3000",
            "create_token": False,
            "existing_token": token,
            "target": "cpp",
            "profile": "full",
        },
    )
    _assert_personal_exe(r, "https://corax.lan:3000", token)
