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
    username = settings.bootstrap_admin_username.strip()
    password = (settings.bootstrap_admin_password or "").strip()
    r = client.post(
        "/api/v1/auth/login/json",
        json={"username": username, "password": password, "return_token": True},
    )
    assert r.status_code == 200, r.text
    token = r.json().get("access_token")
    assert token
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="session")
def agent_headers() -> dict[str, str]:
    token = (settings.agent_token or "").strip()
    assert token, "AGENT_TOKEN must be set for agent API tests"
    return {"Authorization": f"Bearer {token}"}
