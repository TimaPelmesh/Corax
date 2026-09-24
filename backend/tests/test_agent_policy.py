from datetime import datetime, timedelta, timezone

from starlette.testclient import TestClient

from app.agent_policy import apply_schedule_bump, directive_for, hostnames_match, schedule_slot
from app.models import AgentCollectPolicy


def _policy(**kwargs) -> AgentCollectPolicy:
    row = AgentCollectPolicy(
        id=1,
        mode="daily",
        time_hhmm="09:00",
        weekday=0,
        timezone="Europe/Moscow",
        generation=2,
        last_slot="",
        last_reason="schedule",
        poll_minutes=5,
    )
    for key, value in kwargs.items():
        setattr(row, key, value)
    return row


def test_hostname_match_ignores_case_and_domain():
    assert hostnames_match("Ivanov", "IVANOV")
    assert hostnames_match("IVANOV.corp.local", "ivanov")
    assert not hostnames_match("ivanov", "petrov")


def test_schedule_slot_matches_server_clock():
    msk = timezone(timedelta(hours=3))
    now = datetime(2026, 9, 24, 9, 0, tzinfo=msk)
    assert schedule_slot(_policy(), now) == "2026-09-24T09:00"
    later = datetime(2026, 9, 24, 9, 5, tzinfo=msk)
    assert schedule_slot(_policy(), later) is None


def test_weekly_respects_weekday():
    msk = timezone(timedelta(hours=3))
    monday = datetime(2026, 9, 21, 9, 0, tzinfo=msk)
    tuesday = datetime(2026, 9, 22, 9, 0, tzinfo=msk)
    policy = _policy(mode="weekly", weekday=0)
    assert schedule_slot(policy, monday) == "2026-09-21T09:00"
    assert schedule_slot(policy, tuesday) is None


def test_bump_once_per_slot():
    policy = _policy(generation=1, last_slot="")
    now = datetime(2026, 9, 24, 9, 0, tzinfo=timezone(timedelta(hours=3)))
    assert apply_schedule_bump(policy, now) is True
    assert policy.generation == 2
    assert apply_schedule_bump(policy, now) is False


def test_directive_idle_until_generation_or_pending():
    policy = _policy(generation=4, last_reason="now")
    idle = directive_for(policy, seen_generation=4, pending=False)
    assert idle.collect is False
    assert idle.reason == "idle"
    due = directive_for(policy, seen_generation=3, pending=False)
    assert due.collect is True
    assert due.reason == "now"
    one = directive_for(policy, seen_generation=4, pending=True)
    assert one.collect is True
    assert one.reason == "now"


def test_directive_requires_agent_token(client: TestClient):
    r = client.get("/api/v1/agent/directive", params={"hostname": "pc-1", "seen_generation": 0})
    assert r.status_code == 401


def test_collect_now_bumps_generation(client: TestClient, auth_headers: dict[str, str], agent_headers: dict[str, str]):
    saved = client.put(
        "/api/v1/settings/agent-policy",
        json={"mode": "on_demand", "time_hhmm": "09:00", "weekday": 0, "timezone": "Europe/Moscow", "poll_minutes": 5},
        headers=auth_headers,
    )
    assert saved.status_code == 200, saved.text
    before = saved.json()["generation"]

    bumped = client.post("/api/v1/settings/agent-policy/collect-now", json={}, headers=auth_headers)
    assert bumped.status_code == 200, bumped.text
    generation = bumped.json()["generation"]
    assert generation == before + 1

    idle = client.get(
        "/api/v1/agent/directive",
        params={"hostname": "fleet-pc", "seen_generation": generation},
        headers=agent_headers,
    )
    assert idle.status_code == 200, idle.text
    assert idle.json()["collect"] is False

    due = client.get(
        "/api/v1/agent/directive",
        params={"hostname": "fleet-pc", "seen_generation": generation - 1},
        headers=agent_headers,
    )
    assert due.status_code == 200, due.text
    assert due.json()["collect"] is True
    assert due.json()["reason"] == "now"
