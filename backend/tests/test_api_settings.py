from __future__ import annotations

from starlette.testclient import TestClient


def test_settings_ldap_and_bitrix24(client: TestClient, auth_headers: dict[str, str]):
    ldap = client.get("/api/v1/settings/ldap", headers=auth_headers)
    assert ldap.status_code == 200
    assert "enabled" in ldap.json()

    bitrix = client.get("/api/v1/settings/bitrix24", headers=auth_headers)
    assert bitrix.status_code == 200

    ldap_put = client.put(
        "/api/v1/settings/ldap",
        headers=auth_headers,
        json={
            "enabled": False,
            "allow_anonymous": False,
            "uri": "",
            "bind_dn": "",
            "bind_password": "",
            "user_search_base": "",
            "user_filter": "(&(objectClass=user)(objectCategory=person))",
            "username_attr": "sAMAccountName",
            "display_name_attr": "displayName",
            "email_attr": "mail",
            "sync_limit": 500,
        },
    )
    assert ldap_put.status_code == 200
    assert ldap_put.json()["enabled"] is False
