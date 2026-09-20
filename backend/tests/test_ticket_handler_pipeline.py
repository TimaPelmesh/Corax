from __future__ import annotations

from app.routers.ticket_handler import _parse_pipeline, _validate_pipeline


def test_parse_pipeline_falls_back_on_empty_and_invalid():
    empty = _parse_pipeline(None)
    assert empty[0].id == "intake"
    assert any(step.id == "create_ticket" for step in empty)
    assert _parse_pipeline("{")[0].id == "intake"
    assert _parse_pipeline("[]")[0].id == "intake"


def test_parse_pipeline_keeps_known_steps():
    raw = (
        '[{"id":"intake","enabled":true,"label":"In"},'
        '{"id":"classify","enabled":false,"label":"AI","params":{"x":1}}]'
    )
    steps = _parse_pipeline(raw)
    assert [s.id for s in steps] == ["intake", "classify"]
    assert steps[1].enabled is False
    assert steps[1].params == {"x": 1}


def test_validate_pipeline_requires_intake():
    steps = _parse_pipeline('[{"id":"classify","enabled":true,"label":"AI"}]')
    errors = _validate_pipeline(steps)
    assert any("intake" in err for err in errors)
