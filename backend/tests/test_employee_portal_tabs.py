from fastapi import HTTPException

from app.employee_portal_tabs import normalize_employee_tabs, public_employee_tabs


def test_normalize_assigns_ids_and_keeps_table():
    tabs = normalize_employee_tabs(
        [
            {"title": "Телефоны", "kind": "table", "columns": ["Кто", "Номер"], "rows": [["IT", "100"]]},
            {"title": "VPN", "kind": "text", "body": "gateway.corp", "enabled": False},
        ]
    )
    assert len(tabs) == 2
    assert tabs[0]["id"]
    assert tabs[0]["columns"] == ["Кто", "Номер"]
    assert tabs[0]["rows"] == [["IT", "100"]]
    assert tabs[1]["enabled"] is False
    public = public_employee_tabs(__import__("json").dumps(tabs, ensure_ascii=False))
    assert [t["title"] for t in public] == ["Телефоны"]


def test_normalize_rejects_empty_title():
    try:
        normalize_employee_tabs([{"title": "  "}])
    except HTTPException as exc:
        assert "заголовок" in str(exc.detail)
    else:
        raise AssertionError("expected HTTPException")
