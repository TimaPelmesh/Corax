from __future__ import annotations

import pytest

from app.assist_hub import AssistHub


@pytest.mark.asyncio
async def test_offer_wait_answer_and_busy():
    hub = AssistHub()
    sess = await hub.create("PC-LAB-01", 7, "Иван")
    assert sess.status == "offered"
    pending = await hub.wait_offer("pc-lab-01", timeout=0.2)
    assert pending is not None
    assert pending.id == sess.id
    assert pending.admin_name == "Иван"

    answered = await hub.answer(sess.id, "PC-LAB-01", True)
    assert answered is not None
    assert answered.status == "accepted"

    with pytest.raises(RuntimeError):
        await hub.create("pc-lab-01", 8, "Пётр")

    events = await hub.push_frame(sess.id, "PC-LAB-01", b"jpeg-bytes", {"mon": 0, "mc": 1})
    assert events == []
    live = await hub.get(sess.id)
    assert live is not None
    assert live.status == "live"

    await hub.push_input(sess.id, [{"t": "m", "x": 0.5, "y": 0.5, "b": 0, "d": 2}])
    queued = await hub.push_frame(sess.id, "PC-LAB-01", b"next")
    assert queued == [{"t": "m", "x": 0.5, "y": 0.5, "b": 0, "d": 2}]


@pytest.mark.asyncio
async def test_input_coalesces_moves_and_keeps_clicks():
    hub = AssistHub()
    sess = await hub.create("PC-LAB-02", 1, "Анна")
    await hub.answer(sess.id, "PC-LAB-02", True)
    await hub.push_frame(sess.id, "PC-LAB-02", b"jpeg")
    await hub.push_input(
        sess.id,
        [
            {"t": "m", "x": 0.1, "y": 0.1, "b": 0, "d": 2},
            {"t": "m", "x": 0.2, "y": 0.2, "b": 0, "d": 2},
            {"t": "m", "x": 0.3, "y": 0.3, "b": 0, "d": 1},
            {"t": "m", "x": 0.3, "y": 0.3, "b": 0, "d": 0},
        ],
    )
    events = await hub.pull_input(sess.id, "PC-LAB-02")
    assert events == [
        {"t": "m", "x": 0.2, "y": 0.2, "b": 0, "d": 2},
        {"t": "m", "x": 0.3, "y": 0.3, "b": 0, "d": 1},
        {"t": "m", "x": 0.3, "y": 0.3, "b": 0, "d": 0},
    ]
    empty = await hub.pull_input(sess.id, "PC-LAB-02")
    assert empty == []
    assert await hub.pull_input(sess.id, "OTHER-PC") is None

    await hub.end(sess.id)
    gone = await hub.get(sess.id)
    assert gone is None or gone.status == "ended"


@pytest.mark.asyncio
async def test_short_hostname_matches_fqdn():
    hub = AssistHub()
    sess = await hub.create("pc-lab-01.office.lan", 1, "Анна")
    pending = await hub.wait_offer("PC-LAB-01", timeout=0.2)
    assert pending is not None
    assert pending.id == sess.id
    answered = await hub.answer(sess.id, "PC-LAB-01", True)
    assert answered is not None


@pytest.mark.asyncio
async def test_idle_wait_times_out():
    hub = AssistHub()
    pending = await hub.wait_offer("nobody", timeout=0.15)
    assert pending is None
