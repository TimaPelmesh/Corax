from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.server_audit_store import _due, bucket_downsample, keep_cap, minutes_mirror


def test_due_uses_seconds():
    now = datetime(2026, 10, 24, tzinfo=timezone.utc)
    assert _due(now - timedelta(seconds=14), now, 15) is False
    assert _due(now - timedelta(seconds=15), now, 15) is True
    assert _due(None, now, 15) is True


def test_minutes_mirror_keeps_old_agents_on_a_minute():
    assert minutes_mirror(0) == 0
    assert minutes_mirror(15) == 1
    assert minutes_mirror(30) == 1
    assert minutes_mirror(60) == 1
    assert minutes_mirror(300) == 5


def test_keep_cap_holds_two_weeks_at_15_seconds():
    assert keep_cap(15) == 80_000
    assert keep_cap(900) == 1500
    assert keep_cap(0) == 1500


def test_bucket_downsample_keeps_the_spike():
    start = datetime(2026, 10, 24, tzinfo=timezone.utc)
    rows = []
    for index in range(100):
        rows.append(
            SimpleNamespace(
                collected_at=start + timedelta(minutes=index),
                cpu_temp_c=40.0,
                gpu_temp_c=None,
                cpu_used_percent=1.0,
                mem_used_percent=1.0,
                swap_used_percent=None,
                disk_used_percent=1.0,
                load_1=0.1,
                net_rx_bps=1.0,
                net_tx_bps=1.0,
            )
        )
    rows[50].cpu_temp_c = 99.0
    picked = bucket_downsample(rows, cap=40)
    assert any(row.cpu_temp_c == 99.0 for row in picked)
    assert picked[0] is rows[0]
    assert picked[-1] is rows[-1]
