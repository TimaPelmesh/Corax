from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx

from app.glpi_client import (
    GlpiCredentials,
    GlpiDevice,
    GlpiDeviceOutbound,
    device_is_stale,
    fetch_devices,
    parse_device,
    push_devices,
)
from app.glpi_devices import apply_monitor, apply_printer, match_device


def _creds() -> GlpiCredentials:
    return GlpiCredentials(
        base_url="http://glpi.local/glpi",
        api_mode="v2",
        grant_type="password",
        client_id="corax-client",
        client_secret="sekret-value",
        username="glpi",
        password="pw-secret-99",
        verify_tls=False,
    )


def _row(**values: object) -> object:
    base = {
        "glpi_id": None,
        "name": "",
        "serial_number": None,
        "inventory_number": None,
        "manufacturer": None,
        "model": None,
        "glpi_model": None,
        "organization": None,
        "glpi_contact_raw": None,
        "assigned_user_id": None,
        "glpi_updated_at": None,
        "location": None,
        "location_manual": False,
        "notes": None,
        "snmp_model": None,
    }
    base.update(values)
    return type("Row", (), base)()


def test_parse_device_keeps_id_and_clock():
    device = parse_device(
        {
            "id": 15,
            "name": "Dell P2419H",
            "serial": "CN-1",
            "otherserial": "INV-9",
            "manufacturer": {"id": 3, "name": "Dell"},
            "monitormodels_id": {"id": 4, "name": "P2419H"},
            "date_mod": "29-09-2026 17:35:08",
            "date_creation": "2026-01-02 09:00:00",
        }
    )
    assert device is not None
    assert device.glpi_id == 15
    assert device.serial == "CN-1"
    assert device.inventory == "INV-9"
    assert device.manufacturer == "Dell"
    assert device.model == "P2419H"
    assert device.updated_at == datetime(2026, 9, 29, 17, 35, 8, tzinfo=timezone.utc)
    assert device.created_at == datetime(2026, 1, 2, 9, 0, tzinfo=timezone.utc)


def test_older_stamp_does_not_overwrite_and_equal_second_does():
    stored = datetime(2026, 9, 29, 18, 0, 0, tzinfo=timezone.utc)
    older = datetime(2026, 9, 29, 17, 35, 8, tzinfo=timezone.utc)
    assert device_is_stale(older, stored)
    assert not device_is_stale(datetime(2026, 9, 29, 18, 0, 0, 900000, tzinfo=timezone.utc), stored)

    row = _row(glpi_id=15, name="Keep", serial_number="KEEP", glpi_updated_at=stored)
    action = apply_monitor(
        row,
        GlpiDevice(glpi_id=15, name="Replace", serial="NEW", updated_at=older),
        {},
    )
    assert action == "skipped"
    assert row.name == "Keep"
    assert row.serial_number == "KEEP"

    fresh = apply_monitor(
        row,
        GlpiDevice(
            glpi_id=15,
            name="Replace",
            serial="NEW",
            updated_at=datetime(2026, 9, 29, 18, 0, 0, 400000, tzinfo=timezone.utc),
        ),
        {},
    )
    assert fresh == "updated"
    assert row.name == "Replace"
    assert row.serial_number == "NEW"
    assert row.glpi_updated_at == datetime(2026, 9, 29, 18, 0, 0, 400000, tzinfo=timezone.utc)


def test_match_prefers_glpi_id_over_a_shared_name():
    first = _row(glpi_id=4, name="HP", serial_number="A")
    second = _row(glpi_id=5, name="HP", serial_number="B")
    asset = GlpiDevice(glpi_id=5, name="Other", serial="ZZ")
    assert match_device([first, second], asset) is second


def test_match_refuses_an_ambiguous_serial():
    rows = [_row(name="One", serial_number="SN"), _row(name="Two", serial_number="sn")]
    try:
        match_device(rows, GlpiDevice(glpi_id=9, name="Unique", serial="SN"))
    except ValueError:
        return
    raise AssertionError("ambiguous serial must not fall through to the name")


def test_fetch_devices_requests_only_chosen_ids():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path.endswith("/api.php/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        if request.url.path.endswith("/Assets/Monitor/15"):
            return httpx.Response(
                200,
                json={"id": 15, "name": "Left", "serial": "L", "date_mod": "2026-09-29 17:35:08"},
            )
        if request.url.path.endswith("/Assets/Monitor/16"):
            return httpx.Response(
                200,
                json={"id": 16, "name": "Right", "otherserial": "INV", "date_mod": "2026-09-29 18:01:02"},
            )
        return httpx.Response(404, json={"message": request.url.path})

    devices = fetch_devices(_creds(), "monitor", 200, glpi_ids=[16, 15, 16], transport=httpx.MockTransport(handler))
    assert [item.glpi_id for item in devices] == [16, 15] or sorted(item.glpi_id for item in devices) == [15, 16]
    assert not any(path.endswith("/Assets/Monitor") for path in seen)
    by_id = {item.glpi_id: item for item in devices}
    assert by_id[15].updated_at == datetime(2026, 9, 29, 17, 35, 8, tzinfo=timezone.utc)
    assert by_id[16].inventory == "INV"


def test_push_device_updates_chosen_id_and_reads_the_stamp_back():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/api.php/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        if path.endswith("/Assets/Printer/4") and request.method == "GET":
            return httpx.Response(
                200,
                json={"id": 4, "name": "HP", "serial": "SN", "date_mod": "2026-09-29 17:40:00"},
            )
        if path.endswith("/Assets/Printer/4") and request.method == "PATCH":
            body = request.read()
            assert b'"serial":"SN-2"' in body or b'"serial": "SN-2"' in body
            assert b"otherserial" in body
            return httpx.Response(200, json={"id": 4})
        return httpx.Response(404, json={"message": f"{request.method} {path}"})

    results = push_devices(
        _creds(),
        [
            GlpiDeviceOutbound(
                corax_id=8,
                kind="printer",
                name="HP",
                glpi_id=4,
                serial="SN-2",
                inventory="INV-2",
            )
        ],
        transport=httpx.MockTransport(handler),
    )
    assert results[0].action == "updated"
    assert results[0].glpi_id == 4
    assert results[0].updated_at == datetime(2026, 9, 29, 17, 40, tzinfo=timezone.utc)


def test_push_monitor_creates_via_hl_with_dropdown_manufacturer():
    created: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/api.php/token"):
            return httpx.Response(200, json={"access_token": "atk", "expires_in": 3600})
        if path.endswith("/Assets/Monitor") and request.method == "GET":
            return httpx.Response(200, json=[])
        if path.endswith("/Dropdowns/Manufacturer") and request.method == "GET":
            return httpx.Response(200, json=[])
        if path.endswith("/Dropdowns/Manufacturer") and request.method == "POST":
            return httpx.Response(201, json={"id": 55, "href": "/Manufacturer/55"})
        if path.endswith("/Dropdowns/MonitorModel") and request.method == "GET":
            return httpx.Response(200, json=[{"id": 9, "name": "P2419H"}])
        if path.endswith("/Assets/Monitor") and request.method == "POST":
            created.append(json.loads(request.content.decode()))
            return httpx.Response(201, json={"id": 88, "href": "/Assets/Monitor/88"})
        if path.endswith("/Assets/Monitor/88") and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "id": 88,
                    "name": "Dell P2419H",
                    "serial": "CN-1",
                    "date_mod": "2026-09-30 12:00:00",
                },
            )
        return httpx.Response(404, json={"message": f"{request.method} {path}"})

    results = push_devices(
        _creds(),
        [
            GlpiDeviceOutbound(
                corax_id=3,
                kind="monitor",
                name="Dell P2419H",
                serial="CN-1",
                manufacturer="Dell",
                model="P2419H",
            )
        ],
        transport=httpx.MockTransport(handler),
    )
    assert results[0].action == "created", results[0].error
    assert results[0].glpi_id == 88
    assert created[0]["name"] == "Dell P2419H"
    assert created[0]["serial"] == "CN-1"
    assert created[0]["manufacturer"] == {"id": 55}
    assert created[0]["model"] == {"id": 9}
