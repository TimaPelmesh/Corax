from __future__ import annotations

import pytest
from helpers import unique_hostname
from starlette.testclient import TestClient

from app.auth import hash_password
from app.database import AsyncSessionLocal
from app.models import User


@pytest.mark.asyncio
async def test_link_local_account_to_ad_directory(client: TestClient, auth_headers: dict[str, str]):
    ad_username = unique_hostname("ad-link")
    local_username = unique_hostname("local-link")

    async with AsyncSessionLocal() as db:
        ad = User(
            username=ad_username,
            hashed_password=hash_password("unused-ad"),
            full_name="AD Linked Person",
            is_active=True,
            is_superuser=False,
            role="directory",
            is_ldap=True,
        )
        db.add(ad)
        await db.commit()
        await db.refresh(ad)
        ad_id = ad.id

    created = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={
            "username": local_username,
            "password": "LocalPass1!",
            "full_name": "Local Operator",
            "is_superuser": False,
            "role": "editor",
            "linked_directory_user_id": ad_id,
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    local_id = body["id"]
    assert body["linked_directory_user_id"] == ad_id
    assert body["linked_directory_username"] == ad_username
    assert body["linked_directory_full_name"] == "AD Linked Person"

    login = client.post(
        "/api/v1/auth/login/json",
        json={"username": local_username, "password": "LocalPass1!", "return_token": True},
    )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["linked_directory_user_id"] == ad_id

    # Один AD-человек — только одна привязка.
    other = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={
            "username": unique_hostname("local-dup"),
            "password": "LocalPass1!",
            "role": "observer",
            "linked_directory_user_id": ad_id,
        },
    )
    assert other.status_code == 400

    unlinked = client.patch(
        f"/api/v1/users/{local_id}",
        headers=auth_headers,
        json={"linked_directory_user_id": None},
    )
    assert unlinked.status_code == 200, unlinked.text
    assert unlinked.json()["linked_directory_user_id"] is None

    client.post(f"/api/v1/users/{local_id}/delete", headers=auth_headers)
    client.post(f"/api/v1/users/{ad_id}/delete", headers=auth_headers)


@pytest.mark.asyncio
async def test_cannot_link_to_another_local_account(client: TestClient, auth_headers: dict[str, str]):
    a = unique_hostname("local-a")
    b = unique_hostname("local-b")
    created_a = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={"username": a, "password": "LocalPass1!", "role": "observer"},
    )
    created_b = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={"username": b, "password": "LocalPass1!", "role": "observer"},
    )
    assert created_a.status_code == 200 and created_b.status_code == 200
    id_a, id_b = created_a.json()["id"], created_b.json()["id"]

    bad = client.patch(
        f"/api/v1/users/{id_a}",
        headers=auth_headers,
        json={"linked_directory_user_id": id_b},
    )
    assert bad.status_code == 400

    client.post(f"/api/v1/users/{id_a}/delete", headers=auth_headers)
    client.post(f"/api/v1/users/{id_b}/delete", headers=auth_headers)
