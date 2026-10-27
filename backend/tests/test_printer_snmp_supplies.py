from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from app.printer_snmp import _calc_percent, _load_supplies, _supply_label


def test_percent_uses_unit_when_capacity_is_unknown():
    assert _calc_percent(37, -2, unit=19) == 37
    assert _calc_percent(4000, 8000) == 50
    assert _calc_percent(-3, -2, unit=19) is None
    assert _calc_percent(-2, 100) is None


def test_broken_description_keeps_a_typed_name():
    assert _supply_label("\x00\x01", 21, "1.1") == "Картридж с тонером 1"
    assert _supply_label("?? cyan ??", 3, "1.2") == "Тонер · голубой"
    assert _supply_label("Black Cartridge CE285A", 3, "1.1")


def test_load_supplies_keeps_drum_and_drops_waste():
    tables = {
        "1.3.6.1.2.1.43.11.1.1.6": {
            "1.1": "Black Cartridge",
            "1.2": "????",
            "1.3": "Waste Toner",
            "1.4": "Imaging Drum",
        },
        "1.3.6.1.2.1.43.11.1.1.5": {"1.1": 3, "1.2": 21, "1.3": 4, "1.4": 9},
        "1.3.6.1.2.1.43.11.1.1.7": {"1.1": 19, "1.2": 19, "1.4": 15},
        "1.3.6.1.2.1.43.11.1.1.8": {"1.1": -2, "1.2": -2, "1.4": 100},
        "1.3.6.1.2.1.43.11.1.1.9": {"1.1": 41, "1.2": -3, "1.4": 80},
    }

    async def fake_walk(_client, base_oid, _timeout):
        return tables.get(base_oid, {}), None

    with patch("app.printer_snmp._walk_oid_map", new=AsyncMock(side_effect=fake_walk)):
        supplies, errors = asyncio.run(_load_supplies(object(), timeout=1.0))
    names = {s.name: s for s in supplies}
    assert not errors
    assert names["Black Cartridge"].level_percent == 41
    assert any(name.startswith("Картридж с тонером") for name in names)
    toner = next(s for s in supplies if s.name.startswith("Картридж с тонером"))
    assert toner.level_percent is None
    assert toner.level_raw == -3
    assert "Waste Toner" not in names
    assert names["Imaging Drum"].level_percent == 80
