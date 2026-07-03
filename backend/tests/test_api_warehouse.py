from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient


def test_warehouse_rooms_and_items(client: TestClient, auth_headers: dict[str, str]):
    presets = client.get("/api/v1/warehouse/presets", headers=auth_headers)
    assert presets.status_code == 200
    assert isinstance(presets.json(), list)

    rooms = client.get("/api/v1/warehouse/rooms", headers=auth_headers)
    assert rooms.status_code == 200
    assert len(rooms.json()) >= 1
    room_id = rooms.json()[0]["id"]

    room = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Склад {unique_hostname('wh')}"},
    )
    assert room.status_code == 200
    new_room_id = room.json()["id"]

    code = client.get("/api/v1/warehouse/next-code", headers=auth_headers)
    assert code.status_code == 200
    assert "internal_code" in code.json()

    item = client.post(
        "/api/v1/warehouse/items",
        headers=auth_headers,
        json={
            "room_id": new_room_id,
            "preset_key": "custom",
            "name": f"Кабель HDMI {unique_hostname('item')}",
            "tracking_mode": "lot",
            "quantity": 3,
            "condition": "new",
        },
    )
    assert item.status_code == 200, item.text
    item_id = item.json()["id"]

    items = client.get("/api/v1/warehouse/items", headers=auth_headers, params={"room_id": new_room_id})
    assert items.status_code == 200
    assert any(x["id"] == item_id for x in items.json())

    movements = client.get("/api/v1/warehouse/movements", headers=auth_headers, params={"item_id": item_id})
    assert movements.status_code == 200

    deleted_item = client.delete(f"/api/v1/warehouse/items/{item_id}", headers=auth_headers)
    assert deleted_item.status_code == 204

    deleted_room = client.delete(f"/api/v1/warehouse/rooms/{new_room_id}", headers=auth_headers)
    assert deleted_room.status_code == 204

    assert room_id  # default room still exists
