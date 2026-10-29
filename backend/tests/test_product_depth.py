from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.bot_intake import intake_step
from app.product_depth import (
    backup_due,
    computer_reply,
    dump_can_open,
    host_key_action,
    night_feed,
    overdue_reason,
    parse_followups,
    parse_licenses,
    settings_board,
    sla_reply,
    stock_reply,
)

NOW = datetime(2026, 10, 29, 8, 0, tzinfo=timezone.utc)


def test_settings_board_marks_failed_probe_and_silent_agents():
    rows = {
        item["path"]: item
        for item in settings_board(
            {
                "zabbix_enabled": True,
                "zabbix_configured": True,
                "zabbix_last_ok": False,
                "zabbix_checked_at": NOW,
                "glpi_enabled": True,
                "glpi_configured": True,
                "glpi_last_ok": True,
                "glpi_checked_at": NOW - timedelta(days=30),
                "ldap_enabled": True,
                "ldap_configured": True,
                "bitrix_enabled": True,
                "bitrix_configured": True,
                "bitrix_paused": True,
                "llm_servers": 1,
                "pg_dump": True,
                "backup_due": True,
                "agent_tokens": 4,
                "agent_silent": 2,
                "wol_enabled": False,
                "https_enabled": True,
                "https_not_after": NOW + timedelta(days=3),
            },
            NOW,
        )
    }
    assert rows["/settings/zabbix"]["state"] == "error"
    assert rows["/settings/glpi"]["state"] == "stale"
    assert rows["/settings/bitrix24"]["code"] == "paused"
    assert rows["/settings/database"]["code"] == "backup_due"
    assert rows["/settings/agent-tokens"]["count"] == 2
    assert rows["/settings/https"]["code"] == "cert_soon"
    assert rows["/settings/wol"]["state"] == "off"
    assert rows["/settings/tags"]["state"] == "local"


def test_overdue_uses_plan_before_age_window():
    opened = NOW - timedelta(hours=2)
    assert overdue_reason("low", opened, NOW - timedelta(minutes=1), NOW) == "deadline"
    assert overdue_reason("high", NOW - timedelta(hours=9), None, NOW) == "age"
    assert overdue_reason("normal", NOW - timedelta(hours=10), None, NOW) is None


def test_night_feed_and_bot_replies():
    items = night_feed(
        offline=[{"hostname": "pc-1"}],
        tickets=[{"id": 7, "title": "Нет сети", "reason": "deadline"}],
        stock=[{"name": "Картридж", "available": 1}],
    )
    assert [item["kind"] for item in items] == ["offline", "sla", "stock"]
    assert "pc-1" in computer_reply([{"hostname": "pc-1", "ping": "offline", "ip": "10.0.0.4"}])
    assert "не найден" in computer_reply([])
    assert "Картридж" in stock_reply([{"name": "Картридж", "available": 1}])
    assert "нет" in stock_reply([]).lower() or "Позиций" in stock_reply([])
    assert "№7" in sla_reply([{"id": 7, "title": "Нет сети", "reason": "deadline"}])


def test_dump_header_and_schedule_due():
    assert dump_can_open(b"PGDMP" + bytes([1]) + b"\x00" * 80) == (True, "ok")
    assert dump_can_open(b"not a dump" + b"\x00" * 80)[0] is False
    assert dump_can_open(b"PGDMP")[0] is False
    assert backup_due(True, 24, None, NOW) is True
    assert backup_due(True, 24, NOW - timedelta(hours=1), NOW) is False
    assert backup_due(False, 24, None, NOW) is False


def test_host_key_rejects_a_change():
    assert host_key_action(None, "aa") == "remember"
    assert host_key_action("aa", "aa") == "accept"
    assert host_key_action("aa", "bb") == "reject"
    assert host_key_action("aa", "") == "reject"


def test_bot_commands_are_not_swallowed_as_ticket_text():
    assert intake_step("ONIMBOTV2COMMANDADD", "pc", "", enabled=True, waiting=False) == "pc"
    assert intake_step("ONIMBOTV2COMMANDADD", "/stock", "", enabled=True, waiting=True) == "stock"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Срок заявки", enabled=True, waiting=True) == "sla"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Мой компьютер", enabled=True, waiting=False) == "pc"


def test_glpi_followup_and_license_parsers():
    notes = parse_followups(
        [{"id": 3, "content": "<p>Заменили <b>кабель</b></p>", "users_id": 9, "date": "2026-10-01 10:00"}]
    )
    assert notes[0]["content"] == "Заменили кабель"
    assert notes[0]["author"] == "9"
    licenses = parse_licenses([{"id": 1, "name": "Office", "softwares_id": {"name": "Microsoft"}, "number": "10"}])
    assert licenses[0]["software"] == "Microsoft"
    assert licenses[0]["seats"] == 10
    assert parse_followups({"data": []}) == []
