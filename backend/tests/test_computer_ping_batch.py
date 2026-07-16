from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.computer_ping import _clamp_settings, _ping_batch, run_computer_ping_cycle


def test_clamp_settings_bounds(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "computer_ping_concurrency", 99)
    monkeypatch.setattr(settings, "computer_ping_batch_size", 1)
    monkeypatch.setattr(settings, "computer_ping_interval_minutes", 1)
    cfg = _clamp_settings()
    assert cfg["concurrency"] == 8
    assert cfg["batch_size"] == 2
    assert cfg["interval_minutes"] == 5


@pytest.mark.asyncio
async def test_ping_batch_respects_concurrency():
    in_flight = 0
    max_in_flight = 0
    lock = asyncio.Lock()

    async def fake_ping(ip: str, timeout_ms: int = 700) -> bool:
        nonlocal in_flight, max_in_flight
        async with lock:
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
        await asyncio.sleep(0.05)
        async with lock:
            in_flight -= 1
        return True

    items = [(i, f"10.0.0.{i}") for i in range(1, 13)]
    with patch("app.computer_ping.ping_ip", side_effect=fake_ping):
        results = await _ping_batch(items, concurrency=3, timeout_ms=700, jitter_ms=0)

    assert len(results) == 12
    assert all(results.values())
    assert max_in_flight <= 3


@pytest.mark.asyncio
async def test_cycle_batches_and_pauses():
    pcs = []
    for i in range(1, 6):
        c = MagicMock()
        c.id = i
        c.ip_address = f"10.0.0.{i}"
        c.raw_payload = None
        c.ping_status = None
        c.last_ping_at = None
        pcs.append(c)

    db = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.all.return_value = pcs
    db.execute = AsyncMock(return_value=result)
    db.commit = AsyncMock()

    pauses: list[float] = []

    async def fake_sleep(sec: float) -> None:
        pauses.append(sec)

    with (
        patch("app.computer_ping.ping_ip", new=AsyncMock(return_value=True)),
        patch("app.computer_ping.asyncio.sleep", side_effect=fake_sleep),
        patch(
            "app.computer_ping._clamp_settings",
            return_value={
                "interval_minutes": 15,
                "concurrency": 2,
                "batch_size": 2,
                "batch_pause_ms": 200,
                "timeout_ms": 500,
                "jitter_ms": 0,
            },
        ),
    ):
        summary = await run_computer_ping_cycle(db, reason="test")

    assert summary["polled"] == 5
    assert summary["online"] == 5
    assert summary["batches"] == 3  # 2+2+1
    assert len(pauses) == 2  # pause between batches only
    assert db.commit.await_count >= 3
