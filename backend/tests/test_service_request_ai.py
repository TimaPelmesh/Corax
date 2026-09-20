from fastapi.testclient import TestClient


def test_service_request_ai_insights_accepts_json_body(
    client: TestClient,
    auth_headers: dict[str, str],
):
    response = client.post(
        "/api/v1/service-requests/ai-insights",
        headers=auth_headers,
        json={"response_mode": "fast", "force": True, "summary": {"total": 12, "done": 4}},
    )
    assert response.status_code != 422, response.text


def test_service_request_ai_insights_maps_connect_error_to_503(
    client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch,
):
    import httpx

    async def skip_ctx(*_args, **_kwargs):
        return 16384

    async def boom(*_args, **_kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr("app.routers.service_requests.ensure_model_num_ctx", skip_ctx)
    monkeypatch.setattr("app.routers.service_requests.lm_studio_chat", boom)
    response = client.post(
        "/api/v1/service-requests/ai-insights",
        headers=auth_headers,
        json={
            "response_mode": "fast",
            "force": True,
            "base_url": "http://127.0.0.1:11434/v1",
            "summary": {"period": "2026-01-01 - 2026-01-31", "total": 40},
        },
    )
    assert response.status_code == 503, response.text
    assert "Internal server error" not in response.text
