from __future__ import annotations

from helpers import unique_hostname
from starlette.testclient import TestClient


def test_warehouse_rooms_and_items(client: TestClient, auth_headers: dict[str, str]):
    presets = client.get("/api/v1/warehouse/presets", headers=auth_headers)
    assert presets.status_code == 200
    assert isinstance(presets.json(), list)

    rooms = client.get("/api/v1/warehouse/rooms", headers=auth_headers)
    assert rooms.status_code == 200

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


def test_warehouse_delete_room_after_write_off(client: TestClient, auth_headers: dict[str, str]):
    """Written-off items used to block room delete via FK RESTRICT while UI showed 0 items."""
    rooms = client.get("/api/v1/warehouse/rooms", headers=auth_headers)
    assert rooms.status_code == 200

    room = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Склад writeoff {unique_hostname('wh')}"},
    )
    assert room.status_code == 200
    new_room_id = room.json()["id"]

    item = client.post(
        "/api/v1/warehouse/items",
        headers=auth_headers,
        json={
            "room_id": new_room_id,
            "preset_key": "custom",
            "name": f"Мышь {unique_hostname('item')}",
            "tracking_mode": "unit",
            "quantity": 1,
            "condition": "used",
        },
    )
    assert item.status_code == 200, item.text
    item_id = item.json()["id"]

    wo = client.post(f"/api/v1/warehouse/items/{item_id}/write-off", headers=auth_headers)
    assert wo.status_code == 200, wo.text
    assert wo.json()["status"] == "written_off"

    listed = client.get("/api/v1/warehouse/items", headers=auth_headers, params={"room_id": new_room_id})
    assert listed.status_code == 200
    assert listed.json() == []

    rooms_after = client.get("/api/v1/warehouse/rooms", headers=auth_headers)
    assert rooms_after.status_code == 200
    meta = next(r for r in rooms_after.json() if r["id"] == new_room_id)
    assert meta["item_count"] == 0

    deleted_room = client.delete(f"/api/v1/warehouse/rooms/{new_room_id}", headers=auth_headers)
    assert deleted_room.status_code == 204, deleted_room.text


def test_warehouse_delete_room_with_purge(client: TestClient, auth_headers: dict[str, str]):
    room = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Склад purge {unique_hostname('wh')}"},
    )
    assert room.status_code == 200
    room_id = room.json()["id"]
    item = client.post(
        "/api/v1/warehouse/items",
        headers=auth_headers,
        json={
            "room_id": room_id,
            "preset_key": "other",
            "name": f"Кабель {unique_hostname('item')}",
            "tracking_mode": "lot",
            "quantity": 4,
        },
    )
    assert item.status_code == 200, item.text
    blocked = client.delete(f"/api/v1/warehouse/rooms/{room_id}", headers=auth_headers)
    assert blocked.status_code == 409
    purged = client.delete(f"/api/v1/warehouse/rooms/{room_id}", headers=auth_headers, params={"purge": True})
    assert purged.status_code == 204, purged.text
    rooms = client.get("/api/v1/warehouse/rooms", headers=auth_headers)
    assert all(r["id"] != room_id for r in rooms.json())


def test_warehouse_unit_qty_creates_many_with_auto_code(client: TestClient, auth_headers: dict[str, str]):
    room = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Склад units {unique_hostname('wh')}"},
    )
    assert room.status_code == 200
    room_id = room.json()["id"]
    name = f"SSD {unique_hostname('ssd')}"

    created = client.post(
        "/api/v1/warehouse/items",
        headers=auth_headers,
        json={
            "room_id": room_id,
            "preset_key": "ssd",
            "name": name,
            "tracking_mode": "unit",
            "quantity": 3,
            "condition": "new",
            "auto_code": True,
        },
    )
    assert created.status_code == 200, created.text

    items = client.get("/api/v1/warehouse/items", headers=auth_headers, params={"room_id": room_id})
    assert items.status_code == 200
    rows = [x for x in items.json() if x["name"] == name]
    assert len(rows) == 1
    assert rows[0]["quantity_available"] == 3
    assert rows[0]["tracking_mode"] == "lot"
    assert rows[0]["internal_code"]

    client.delete(f"/api/v1/warehouse/items/{rows[0]['id']}", headers=auth_headers)
    client.delete(f"/api/v1/warehouse/rooms/{room_id}", headers=auth_headers)


def test_warehouse_increase_quantity(client: TestClient, auth_headers: dict[str, str]):
    room = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Склад qty {unique_hostname('wh')}"},
    )
    assert room.status_code == 200
    room_id = room.json()["id"]
    name = f"DDR4 {unique_hostname('ram')}"

    created = client.post(
        "/api/v1/warehouse/items",
        headers=auth_headers,
        json={
            "room_id": room_id,
            "preset_key": "ram",
            "name": name,
            "tracking_mode": "unit",
            "quantity": 2,
            "condition": "new",
            "auto_code": True,
        },
    )
    assert created.status_code == 200, created.text
    item_id = created.json()["id"]
    assert created.json()["quantity_available"] == 2
    assert created.json()["tracking_mode"] == "lot"

    patched = client.patch(
        f"/api/v1/warehouse/items/{item_id}",
        headers=auth_headers,
        json={"quantity": 5},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["quantity_available"] == 5
    assert patched.json()["tracking_mode"] == "lot"

    movements = client.get(
        "/api/v1/warehouse/movements",
        headers=auth_headers,
        params={"item_id": item_id},
    )
    assert movements.status_code == 200
    adjusts = [m for m in movements.json() if m["movement_kind"] == "adjust"]
    assert len(adjusts) == 1
    assert adjusts[0]["quantity"] == 3

    client.delete(f"/api/v1/warehouse/items/{item_id}", headers=auth_headers)
    client.delete(f"/api/v1/warehouse/rooms/{room_id}", headers=auth_headers)


def test_warehouse_partial_write_off_and_manufacturer(client: TestClient, auth_headers: dict[str, str]):
    room = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Склад lots {unique_hostname('wh')}"},
    )
    assert room.status_code == 200
    room_id = room.json()["id"]
    name = f"Картридж {unique_hostname('cart')}"

    created = client.post(
        "/api/v1/warehouse/items",
        headers=auth_headers,
        json={
            "room_id": room_id,
            "preset_key": "cartridge",
            "name": name,
            "manufacturer": "HP",
            "tracking_mode": "lot",
            "quantity": 5,
            "condition": "new",
            "auto_code": True,
        },
    )
    assert created.status_code == 200, created.text
    item_id = created.json()["id"]
    assert created.json()["manufacturer"] == "HP"
    assert created.json()["quantity_available"] == 5
    assert created.json()["internal_code"]

    found = client.get(
        "/api/v1/warehouse/items",
        headers=auth_headers,
        params={"room_id": room_id, "q": "HP"},
    )
    assert found.status_code == 200
    assert any(x["id"] == item_id for x in found.json())

    too_many = client.post(
        f"/api/v1/warehouse/items/{item_id}/write-off",
        headers=auth_headers,
        params={"quantity": 9},
    )
    assert too_many.status_code == 400

    partial = client.post(
        f"/api/v1/warehouse/items/{item_id}/write-off",
        headers=auth_headers,
        params={"quantity": 2, "comment": "выдали в кабинет 12"},
    )
    assert partial.status_code == 200, partial.text
    assert partial.json()["status"] == "available"
    assert partial.json()["quantity_available"] == 3

    rooms = client.get("/api/v1/warehouse/rooms", headers=auth_headers)
    meta = next(r for r in rooms.json() if r["id"] == room_id)
    assert meta["item_count"] == 3

    rest = client.post(f"/api/v1/warehouse/items/{item_id}/write-off", headers=auth_headers)
    assert rest.status_code == 200
    assert rest.json()["status"] == "written_off"
    assert rest.json()["quantity_available"] == 0

    listed = client.get("/api/v1/warehouse/items", headers=auth_headers, params={"room_id": room_id})
    assert listed.json() == []

    movements = client.get(
        "/api/v1/warehouse/movements",
        headers=auth_headers,
        params={"item_id": item_id},
    )
    assert movements.status_code == 200
    kinds = [m["movement_kind"] for m in movements.json()]
    assert kinds.count("write_off") == 2
    assert kinds.count("receipt") == 1
    sample = next(m for m in movements.json() if m["movement_kind"] == "write_off" and m["quantity"] == 2)
    assert sample["item_name"] == name
    assert sample["item_code"]
    assert sample["manufacturer"] == "HP"
    assert sample["comment"] == "выдали в кабинет 12"

    client.delete(f"/api/v1/warehouse/rooms/{room_id}", headers=auth_headers)


def test_warehouse_glpi_csv_import_merges_and_export_roundtrip(client: TestClient, auth_headers: dict[str, str]):
    room = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"CSV {unique_hostname('wh')}"},
    )
    assert room.status_code == 200
    room_id = room.json()["id"]
    suffix = unique_hostname("cart")
    csv_text = (
        "ID;Название;Производитель;Тип расходного материала;Количество\r\n"
        f"501;HP 107A {suffix};HP;Картридж;1\r\n"
        f"502;HP 107A {suffix};HP;Картридж;1\r\n"
    )
    imported = client.post(
        "/api/v1/warehouse/import.csv",
        headers=auth_headers,
        params={"room_id": room_id},
        files={"file": ("glpi.csv", csv_text.encode("utf-8"), "text/csv")},
    )
    assert imported.status_code == 200, imported.text
    body = imported.json()
    assert body["created"] == 1
    assert body["merged"] is True

    items = client.get("/api/v1/warehouse/items", headers=auth_headers, params={"room_id": room_id})
    assert items.status_code == 200
    rows = [x for x in items.json() if suffix in x["name"]]
    assert len(rows) == 1
    assert rows[0]["quantity_available"] == 2
    assert rows[0]["tracking_mode"] == "lot"
    assert rows[0]["manufacturer"] == "HP"
    assert rows[0]["internal_code"]

    exported = client.get("/api/v1/warehouse/export.csv", headers=auth_headers, params={"room_id": room_id})
    assert exported.status_code == 200, exported.text
    assert "text/csv" in exported.headers.get("content-type", "")
    assert suffix in exported.content.decode("utf-8-sig")

    client.delete(f"/api/v1/warehouse/items/{rows[0]['id']}", headers=auth_headers)
    client.delete(f"/api/v1/warehouse/rooms/{room_id}", headers=auth_headers)


def test_warehouse_admin_can_delete_and_clear_history(client: TestClient, auth_headers: dict[str, str]):
    room = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Hist {unique_hostname('wh')}"},
    )
    assert room.status_code == 200
    room_id = room.json()["id"]
    created = client.post(
        "/api/v1/warehouse/items",
        headers=auth_headers,
        json={
            "room_id": room_id,
            "preset_key": "other",
            "name": f"Кабель {unique_hostname('item')}",
            "tracking_mode": "lot",
            "quantity": 2,
        },
    )
    assert created.status_code == 200, created.text
    item_id = created.json()["id"]
    listed = client.get("/api/v1/warehouse/movements", headers=auth_headers, params={"item_id": item_id})
    assert listed.status_code == 200
    assert listed.json()
    mid = listed.json()[0]["id"]
    deleted = client.delete(f"/api/v1/warehouse/movements/{mid}", headers=auth_headers)
    assert deleted.status_code == 204, deleted.text
    cleared = client.delete("/api/v1/warehouse/movements", headers=auth_headers, params={"room_id": room_id})
    assert cleared.status_code == 200, cleared.text
    client.delete(f"/api/v1/warehouse/items/{item_id}", headers=auth_headers)
    client.delete(f"/api/v1/warehouse/rooms/{room_id}", headers=auth_headers)


def test_warehouse_import_does_not_split_or_move_existing(client: TestClient, auth_headers: dict[str, str]):
    origin = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Origin {unique_hostname('wh')}"},
    )
    target = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Target {unique_hostname('wh')}"},
    )
    assert origin.status_code == 200 and target.status_code == 200
    origin_id = origin.json()["id"]
    target_id = target.json()["id"]
    ext = unique_hostname("eid")
    keep_name = f"Keep {unique_hostname('item')}"
    seeded = client.post(
        "/api/v1/warehouse/items",
        headers=auth_headers,
        json={
            "room_id": origin_id,
            "preset_key": "other",
            "name": keep_name,
            "tracking_mode": "lot",
            "quantity": 2,
            "external_id": ext,
        },
    )
    assert seeded.status_code == 200, seeded.text
    keep_id = seeded.json()["id"]
    suffix = unique_hostname("cart")
    csv_text = (
        "ID;Название;Производитель;Тип расходного материала;Количество;Местоположение\r\n"
        f"{ext};{keep_name} upd;HP;Картридж;1;Кабинет А\r\n"
        f"9{suffix};HP 107A {suffix};HP;Картридж;1;Кабинет Б\r\n"
        f"8{suffix};Кабель {suffix};Generic;Кабель USB / адаптер;3;\r\n"
    )
    imported = client.post(
        "/api/v1/warehouse/import.csv",
        headers=auth_headers,
        params={"room_id": target_id},
        files={"file": ("glpi.csv", csv_text.encode("utf-8"), "text/csv")},
    )
    assert imported.status_code == 200, imported.text
    body = imported.json()
    assert body["room_id"] == target_id
    titles = {r["title"] for r in client.get("/api/v1/warehouse/rooms", headers=auth_headers).json()}
    assert "Кабинет А" not in titles
    assert "Кабинет Б" not in titles

    origin_items = client.get("/api/v1/warehouse/items", headers=auth_headers, params={"room_id": origin_id}).json()
    assert any(x["id"] == keep_id for x in origin_items)
    kept = next(x for x in origin_items if x["id"] == keep_id)
    assert kept["room_id"] == origin_id

    target_items = client.get("/api/v1/warehouse/items", headers=auth_headers, params={"room_id": target_id}).json()
    assert all(x["id"] != keep_id for x in target_items)
    assert any(suffix in x["name"] for x in target_items)

    client.delete(f"/api/v1/warehouse/items/{keep_id}", headers=auth_headers)
    for row in target_items:
        client.delete(f"/api/v1/warehouse/items/{row['id']}", headers=auth_headers)
    client.delete(f"/api/v1/warehouse/rooms/{origin_id}", headers=auth_headers)
    client.delete(f"/api/v1/warehouse/rooms/{target_id}", headers=auth_headers)


def test_warehouse_allows_zero_rooms(client: TestClient, auth_headers: dict[str, str]):
    room = client.post(
        "/api/v1/warehouse/rooms",
        headers=auth_headers,
        json={"title": f"Last {unique_hostname('wh')}"},
    )
    assert room.status_code == 200
    last_id = room.json()["id"]
    leftover = client.get("/api/v1/warehouse/rooms", headers=auth_headers).json()
    for row in leftover:
        if row["id"] == last_id:
            continue
        gone = client.delete(
            f"/api/v1/warehouse/rooms/{row['id']}",
            headers=auth_headers,
            params={"purge": True},
        )
        assert gone.status_code == 204, gone.text
    only = client.get("/api/v1/warehouse/rooms", headers=auth_headers).json()
    assert [r["id"] for r in only] == [last_id]
    deleted = client.delete(f"/api/v1/warehouse/rooms/{last_id}", headers=auth_headers)
    assert deleted.status_code == 204, deleted.text
    empty = client.get("/api/v1/warehouse/rooms", headers=auth_headers)
    assert empty.status_code == 200
    assert empty.json() == []
