from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.remote_assist_policy import (
    can_remote_assist,
    deny_detail,
    normalize_mode,
    policy_public,
    set_policy,
)


def _user(**kwargs):
    base = {
        "is_superuser": False,
        "role": "editor",
        "remote_assist_mode": "all",
        "remote_assist_tag_ids_json": "[]",
        "remote_assist_computer_ids_json": "[]",
    }
    base.update(kwargs)
    return SimpleNamespace(**base)


def _pc(pc_id: int, tag_ids: list[int] | None = None):
    tags = [SimpleNamespace(id=i) for i in (tag_ids or [])]
    return SimpleNamespace(id=pc_id, hostname="PC-LAB", tags=tags)


@pytest.mark.asyncio
async def test_superuser_always_allowed():
    user = _user(is_superuser=True, role="observer", remote_assist_mode="allow")
    ok, reason = await can_remote_assist(None, user, computer=_pc(1))  # type: ignore[arg-type]
    assert ok and reason == ""


@pytest.mark.asyncio
async def test_observer_blocked():
    user = _user(role="observer")
    ok, reason = await can_remote_assist(None, user, computer=_pc(1))  # type: ignore[arg-type]
    assert not ok and reason == "role"
    assert "редактор" in deny_detail(reason).lower() or "Assist" in deny_detail(reason)


@pytest.mark.asyncio
async def test_allow_list_by_tag_and_pc():
    user = _user(remote_assist_mode="allow")
    set_policy(user, tag_ids=[10], computer_ids=[5])
    ok, _ = await can_remote_assist(None, user, computer=_pc(5, []))  # type: ignore[arg-type]
    assert ok
    ok, _ = await can_remote_assist(None, user, computer=_pc(9, [10]))  # type: ignore[arg-type]
    assert ok
    ok, reason = await can_remote_assist(None, user, computer=_pc(9, [11]))  # type: ignore[arg-type]
    assert not ok and reason == "not_in_allowlist"


@pytest.mark.asyncio
async def test_deny_list_blocks_hit():
    user = _user(remote_assist_mode="deny")
    set_policy(user, tag_ids=[7], computer_ids=[3])
    ok, reason = await can_remote_assist(None, user, computer=_pc(3, []))  # type: ignore[arg-type]
    assert not ok and reason == "denied"
    ok, reason = await can_remote_assist(None, user, computer=_pc(8, [7]))  # type: ignore[arg-type]
    assert not ok and reason == "denied"
    ok, _ = await can_remote_assist(None, user, computer=_pc(8, [1]))  # type: ignore[arg-type]
    assert ok


def test_normalize_and_public():
    assert normalize_mode("ALLOW") == "allow"
    assert normalize_mode("nope") == "all"
    user = _user()
    set_policy(user, mode="deny", tag_ids=[1, 1, 2], computer_ids=[9])
    pub = policy_public(user)
    assert pub["remote_assist_mode"] == "deny"
    assert pub["remote_assist_tag_ids"] == [1, 2]
    assert pub["remote_assist_computer_ids"] == [9]
