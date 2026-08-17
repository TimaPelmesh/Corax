"""Unit tests for SNMP-first printer polling."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.models import Printer
from app.printer_poll import poll_single_printer
from app.printer_poll_config import EffectivePrinterPollConfig
from app.printer_snmp import SnmpPrinterSnapshot, SupplyReading


def _cfg(**kwargs) -> EffectivePrinterPollConfig:
    base = EffectivePrinterPollConfig(
        poll_enabled=True,
        snmp_enabled=True,
        snmp_community="public",
        snmp_timeout_seconds=3.5,
        ping_timeout_ms=800,
        poll_concurrency=10,
    )
    for k, v in kwargs.items():
        setattr(base, k, v)
    return base


@pytest.mark.asyncio
async def test_poll_skips_without_ip():
    row = Printer(name="x", source="manual")
    row.ip_address = None
    await poll_single_printer(row, _cfg())
    assert row.snmp_status == "skipped"
    assert "IP" in (row.snmp_error or "")


@pytest.mark.asyncio
async def test_poll_snmp_ok_skips_ping():
    row = Printer(name="old", source="snmp", ip_address="10.0.0.9")
    snap = SnmpPrinterSnapshot(
        model="HP LaserJet M506",
        page_count=12345,
        supplies=[SupplyReading(name="Black Toner", level_percent=42)],
    )
    with (
        patch("app.printer_poll.fetch_printer_snmp", new=AsyncMock(return_value=snap)) as snmp,
        patch("app.printer_poll.ping_ip", new=AsyncMock(return_value=False)) as ping,
    ):
        await poll_single_printer(row, _cfg(), now=datetime.now(timezone.utc))
    assert snmp.await_count == 1
    assert ping.await_count == 0
    assert row.poll_status == "online"
    assert row.snmp_status == "ok"
    assert row.snmp_model == "HP LaserJet M506"
    assert row.page_count == 12345
    assert row.snmp_error is None


@pytest.mark.asyncio
async def test_poll_snmp_fail_then_ping_offline():
    row = Printer(name="x", source="snmp", ip_address="10.0.0.8")
    snap = SnmpPrinterSnapshot(error="timeout")
    with (
        patch("app.printer_poll.fetch_printer_snmp", new=AsyncMock(return_value=snap)),
        patch("app.printer_poll.ping_ip", new=AsyncMock(return_value=False)) as ping,
    ):
        await poll_single_printer(row, _cfg())
    assert ping.await_count == 1
    assert row.poll_status == "offline"
    assert row.snmp_status == "error"
    assert "timeout" in (row.snmp_error or "")
    assert "ping" in (row.snmp_error or "").lower()


@pytest.mark.asyncio
async def test_poll_snmp_disabled_uses_ping_only():
    row = Printer(name="x", source="manual", ip_address="10.0.0.7")
    with (
        patch("app.printer_poll.fetch_printer_snmp", new=AsyncMock()) as snmp,
        patch("app.printer_poll.ping_ip", new=AsyncMock(return_value=True)) as ping,
    ):
        await poll_single_printer(row, _cfg(snmp_enabled=False))
    assert snmp.await_count == 0
    assert ping.await_count == 1
    assert row.poll_status == "online"
    assert row.snmp_status == "skipped"
