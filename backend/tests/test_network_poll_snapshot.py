from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace

from app.network_poll import _apply_snapshot
from app.network_snmp import NetworkSnmpSnapshot


def test_apply_snapshot_truncates_and_keeps_zabbix():
    row = SimpleNamespace(
        extras_json='{"zabbix":{"hostid":"9"},"trace_route":{"hops":[{"ip":"10.0.0.1"}]}}',
        sys_name=None,
        hostname=None,
        sys_descr=None,
        sys_object_id=None,
        location=None,
        device_type="unknown",
        vendor=None,
        interfaces_json=None,
        neighbors_json=None,
        fdb_json=None,
        last_snmp_at=None,
        snmp_status=None,
        snmp_error=None,
        last_seen_at=None,
    )
    snap = NetworkSnmpSnapshot(
        sys_name="core-" + ("x" * 300),
        vendor="cisco-" + ("y" * 200),
        sys_location="rack-" + ("z" * 300),
        device_type="switch",
    )
    asyncio.run(_apply_snapshot(row, snap, datetime.now(timezone.utc)))
    assert len(row.sys_name) == 255
    assert len(row.vendor) == 128
    assert len(row.location) == 255
    extras = json.loads(row.extras_json)
    assert extras["zabbix"]["hostid"] == "9"
    assert extras["trace_route"]["hops"][0]["ip"] == "10.0.0.1"


def test_apply_snapshot_sets_printer_type():
    row = SimpleNamespace(
        extras_json=None,
        sys_name=None,
        hostname=None,
        sys_descr=None,
        sys_object_id=None,
        location=None,
        device_type="host",
        vendor=None,
        interfaces_json=None,
        neighbors_json=None,
        fdb_json=None,
        last_snmp_at=None,
        snmp_status=None,
        snmp_error=None,
        last_seen_at=None,
    )
    snap = NetworkSnmpSnapshot(sys_descr="HP LaserJet Pro", device_type="printer", vendor="HP")
    asyncio.run(_apply_snapshot(row, snap, datetime.now(timezone.utc)))
    assert row.device_type == "printer"
    assert row.snmp_status == "ok"
    assert row.vendor == "HP"


def test_apply_snapshot_keeps_manual_type():
    row = SimpleNamespace(
        extras_json='{"type_manual": true, "zabbix": {"hostid": "1"}}',
        sys_name=None,
        hostname=None,
        sys_descr=None,
        sys_object_id=None,
        location=None,
        device_type="gateway",
        vendor=None,
        interfaces_json=None,
        neighbors_json=None,
        fdb_json=None,
        last_snmp_at=None,
        snmp_status=None,
        snmp_error=None,
        last_seen_at=None,
    )
    snap = NetworkSnmpSnapshot(sys_descr="Linux", device_type="host", vendor="Debian")
    asyncio.run(_apply_snapshot(row, snap, datetime.now(timezone.utc)))
    assert row.device_type == "gateway"
    extras = json.loads(row.extras_json)
    assert extras["type_manual"] is True
    assert extras["zabbix"]["hostid"] == "1"
