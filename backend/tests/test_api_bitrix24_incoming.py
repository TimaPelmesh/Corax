from starlette.testclient import TestClient


def test_bitrix24_incoming_rejected_when_disabled(client: TestClient):
    response = client.post(
        "/api/v1/integrations/bitrix24/incoming",
        json={"title": "Сломался принтер", "text": "не печатает"},
    )
    assert response.status_code == 403
