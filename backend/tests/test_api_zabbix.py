from starlette.testclient import TestClient


def test_zabbix_read_endpoints_shape(client: TestClient, auth_headers: dict[str, str]):
    overview = client.get("/api/v1/zabbix/overview", headers=auth_headers)
    assert overview.status_code == 200, overview.text
    body = overview.json()
    assert "enabled" in body
    assert "available" in body
    assert "message" in body
    if body["enabled"] is False:
        assert body["available"] is False

    problems = client.get("/api/v1/zabbix/problems", headers=auth_headers)
    assert problems.status_code == 200, problems.text
    assert isinstance(problems.json().get("items"), list)

    hosts = client.get("/api/v1/zabbix/hosts", headers=auth_headers)
    assert hosts.status_code == 200, hosts.text
    assert isinstance(hosts.json().get("items"), list)


def test_zabbix_settings_do_not_echo_token(client: TestClient, auth_headers: dict[str, str]):
    fetched = client.get("/api/v1/settings/zabbix", headers=auth_headers)
    assert fetched.status_code == 200, fetched.text
    out = fetched.json()
    assert "api_token" not in out
    assert "api_token_set" in out
    assert isinstance(out["api_token_set"], bool)
    assert '"api_token"' not in fetched.text
    assert "api_token_set" in out
