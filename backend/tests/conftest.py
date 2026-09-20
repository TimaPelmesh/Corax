from __future__ import annotations

import os

os.environ.setdefault("ENVIRONMENT", "test")

import pytest
from starlette.testclient import TestClient

from app.config import settings
from app.main import app


@pytest.fixture(scope="session")
def client() -> TestClient:
    with TestClient(app) as tc:
        yield tc


@pytest.fixture(scope="session")
def auth_headers(client: TestClient) -> dict[str, str]:
    # CI: fresh DB + BOOTSTRAP_ADMIN_* from defaults/.env.example.
    # Local prod-like DB: set TEST_LOGIN_USERNAME / TEST_LOGIN_PASSWORD if bootstrap ≠ real admin.
    username = (os.environ.get("TEST_LOGIN_USERNAME") or settings.bootstrap_admin_username).strip()
    password = (os.environ.get("TEST_LOGIN_PASSWORD") or settings.bootstrap_admin_password or "").strip()
    r = client.post(
        "/api/v1/auth/login/json",
        json={"username": username, "password": password, "return_token": True},
    )
    if r.status_code != 200:
        pytest.exit(
            "auth_headers: login failed "
            f"(HTTP {r.status_code}). "
            "CI uses a fresh Postgres and bootstrap admin. "
            "Locally either point DATABASE_URL at an empty test DB, "
            "or set TEST_LOGIN_USERNAME / TEST_LOGIN_PASSWORD to a real admin. "
            f"Response: {r.text[:200]}",
            returncode=1,
        )
    token = r.json().get("access_token")
    assert token
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="session")
def agent_headers() -> dict[str, str]:
    token = (settings.agent_token or "").strip()
    assert token, "AGENT_TOKEN must be set for agent API tests"
    return {"Authorization": f"Bearer {token}"}
