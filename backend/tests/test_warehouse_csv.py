from app.warehouse_csv import merge_consumable_rows, parse_warehouse_csv, render_warehouse_csv


def test_parse_glpi_consumables_and_merge():
    text = (
        "ID;Название;Производитель;Тип расходного материала;Количество;Местоположение;Серийный номер\r\n"
        "101;HP 107A;HP;Картридж;1;Склад ИТ;\r\n"
        "102;HP 107A;HP;Картридж;1;Склад ИТ;\r\n"
        "103;HP 107A;HP;Картридж;1;Склад ИТ;\r\n"
        "200;Kingston NV2 1TB;Kingston;SSD;1;Серверная;SN-1\r\n"
    )
    rows, warnings = parse_warehouse_csv(text)
    assert not warnings
    assert len(rows) == 4
    merged = merge_consumable_rows(rows)
    lots = [r for r in merged if not r.serial_number]
    serials = [r for r in merged if r.serial_number]
    assert len(lots) == 1
    assert lots[0].quantity == 3
    assert lots[0].name == "HP 107A"
    assert lots[0].manufacturer == "HP"
    assert lots[0].preset_key == "cartridge"
    assert lots[0].external_id == "101"
    assert lots[0].tracking_mode == "lot"
    assert len(serials) == 1
    assert serials[0].serial_number == "SN-1"
    assert serials[0].preset_key == "ssd"


def test_parse_comma_english_headers():
    text = (
        "Name,Manufacturer,Type,Qty,Location\n"
        "Cat6 patch,Generic,Patch cord,12,Closet\n"
    )
    rows, _ = parse_warehouse_csv(text)
    assert len(rows) == 1
    assert rows[0].quantity == 12
    assert rows[0].tracking_mode == "lot"
    assert rows[0].preset_key == "patch_cord"


def test_roundtrip_export_headers():
    payload = render_warehouse_csv(
        [
            {
                "id": 7,
                "name": "HP 107A",
                "manufacturer": "HP",
                "preset_key": "cartridge",
                "preset_name": "Картридж / тонер",
                "tracking_mode": "lot",
                "quantity_available": 4,
                "condition": "new",
                "room_id": 1,
                "internal_code": "СК-0001",
                "serial_number": None,
                "batch_label": None,
                "notes": None,
                "external_id": "101",
            }
        ],
        preset_name={"cartridge": "Картридж / тонер"},
        room_title={1: "Склад ИТ"},
    )
    text = payload.decode("utf-8-sig")
    assert text.splitlines()[0].startswith("Наименование;Организация;Артикул;Тип;Производитель;Местоположение;Количество")
    assert "Всего:" not in text
    rows, _ = parse_warehouse_csv(text)
    assert rows[0].name == "HP 107A"
    assert rows[0].internal_code == "СК-0001"
    assert rows[0].external_id == "101"
    assert rows[0].quantity == 4
    assert rows[0].tracking_mode == "lot"
    assert rows[0].batch_label is None or rows[0].batch_label == ""


def test_parse_glpi_excel_stock_phrase_uses_new_not_used():
    text = (
        "Наименование;Организация;Артикул;Тип;Производитель;Местоположение;Расходные материалы\r\n"
        "HP 107A;ИГ;W1100A;Картридж;HP;Склад ИТ;Всего: 12, Новых 4, Использованных 8\r\n"
        "Кабель USB;ИГ;;Кабель USB / адаптер;Generic;Склад ИТ;Всего: 1, Новых 1, Использованных 0\r\n"
        "Пустой тонер;ИГ;CF400A;Картридж;HP;Склад ИТ;Всего: 5, Новых 0, Использованных 5\r\n"
    )
    rows, warnings = parse_warehouse_csv(text)
    by_name = {r.name: r for r in rows}
    assert by_name["HP 107A"].quantity == 4
    assert by_name["HP 107A"].manufacturer == "HP"
    assert by_name["HP 107A"].batch_label == "W1100A"
    assert by_name["HP 107A"].room_title == "Склад ИТ"
    assert by_name["Кабель USB"].quantity == 1
    assert "Пустой тонер" not in by_name
    assert any("нулевым остатком" in w for w in warnings)


def test_export_quantity_is_plain_number_grouped_by_type():
    payload = render_warehouse_csv(
        [
            {
                "id": 2,
                "name": "Кабель USB-C",
                "manufacturer": "Generic",
                "preset_key": "cable_usb",
                "tracking_mode": "lot",
                "quantity_available": 7,
                "condition": "new",
                "room_id": 1,
                "internal_code": "СК-0002",
                "serial_number": None,
                "batch_label": None,
                "notes": None,
                "external_id": None,
            },
            {
                "id": 1,
                "name": "HP 107A",
                "manufacturer": "HP",
                "preset_key": "cartridge",
                "tracking_mode": "lot",
                "quantity_available": 4,
                "condition": "new",
                "room_id": 1,
                "internal_code": "СК-0001",
                "serial_number": None,
                "batch_label": "W1100A",
                "notes": None,
                "external_id": "101",
            },
        ],
        preset_name={"cartridge": "Картридж / тонер", "cable_usb": "Кабель USB / адаптер"},
        preset_group={"cartridge": "peripherals", "cable_usb": "peripherals"},
        room_title={1: "Склад ИТ"},
    )
    text = payload.decode("utf-8-sig")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    assert "Всего:" not in text
    assert "Использованных" not in text
    hp = next(row for row in lines[1:] if row.startswith("HP 107A;"))
    cols = hp.split(";")
    assert cols[0] == "HP 107A"
    assert cols[2] == "W1100A"
    assert cols[4] == "HP"
    assert cols[5] == "Склад ИТ"
    assert cols[6] == "4"
    usb = next(row for row in lines[1:] if row.startswith("Кабель USB-C;"))
    assert usb.split(";")[6] == "7"

