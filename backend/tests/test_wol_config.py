from __future__ import annotations

from types import SimpleNamespace

from app.wol_config import (
    EffectiveWolConfig,
    check_cooldown,
    mark_woken,
    serialize_id_list,
    user_may_wake,
)


def test_serialize_id_list_dedupes_and_filters():
    assert serialize_id_list([3, 1, 1, 0, -2, 2]) == "[1, 2, 3]"


def test_user_may_wake_superuser_and_grant():
    cfg = EffectiveWolConfig(
        enabled=True,
        allowlist=[],
        wake_user_ids=[42],
        cooldown_seconds=120,
        force_disabled=False,
    )
    su = SimpleNamespace(id=1, is_active=True, is_superuser=True)
    granted = SimpleNamespace(id=42, is_active=True, is_superuser=False)
    other = SimpleNamespace(id=99, is_active=True, is_superuser=False)
    inactive = SimpleNamespace(id=42, is_active=False, is_superuser=False)

    assert user_may_wake(su, cfg) is True
    assert user_may_wake(granted, cfg) is True
    assert user_may_wake(other, cfg) is False
    assert user_may_wake(inactive, cfg) is False


def test_cooldown_disabled_when_zero():
    cid = 9_001_002
    from app import wol_config

    with wol_config._cooldown_lock:
        wol_config._last_wake_monotonic.pop(cid, None)

    mark_woken(cid)
    assert check_cooldown(cid, 0) is None
    assert check_cooldown(cid, -1) is None


def test_cooldown_marks_and_expires(monkeypatch):
    cid = 9_001_001
    # Clear any prior state from other tests.
    from app import wol_config

    with wol_config._cooldown_lock:
        wol_config._last_wake_monotonic.pop(cid, None)

    assert check_cooldown(cid, 120) is None
    mark_woken(cid)
    left = check_cooldown(cid, 120)
    assert left is not None and left > 0

    monkeypatch.setattr(wol_config.time, "monotonic", lambda: wol_config._last_wake_monotonic[cid] + 200)
    assert check_cooldown(cid, 120) is None
