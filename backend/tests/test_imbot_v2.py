import pytest

from datetime import datetime, timedelta, timezone

from app.bot_intake import (
    BotVoice,
    accepted_text,
    ask_text,
    bitrix_title,
    closed_text,
    dump_scripts,
    greeting_text,
    intake_step,
    parse_scripts,
    status_text,
    voice_from_phrases,
)
from app.bitrix_bot_poll import next_offset, wants_fetch
from app.imbot_v2 import (
    ImbotError,
    avatar_base64,
    clean_code,
    dialog_candidates,
    parse_fetch_event,
    parse_v2_event,
    appearance_fields,
    delivery_fields,
    profile_properties,
    clean_email,
    legacy_email_body,
    profile_update_fields,
    public_bots,
    attach_keyboard,
    command_register_body,
    keyboard_sig,
    send_keyboard,
    webhook_base,
    webhook_host,
)


def test_webhook_base_keeps_the_secret_out_of_the_host():
    base = webhook_base("https://portal.example/rest/1/secret_value")
    assert base.endswith("/")
    assert webhook_host(base) == "portal.example"
    assert "secret_value" not in webhook_host(base)
    with pytest.raises(ImbotError):
        webhook_base("https://user:pass@portal.example/rest/1/secret/")
    with pytest.raises(ImbotError):
        webhook_base("https://portal.example/crm/")


def test_bot_code_keeps_what_bitrix_accepts():
    assert clean_code("support_bot") == "support_bot"
    assert clean_code("help-desk") == "help-desk"
    assert clean_code("a") == "a"
    assert clean_code("my bot") == "my_bot"
    with pytest.raises(ImbotError):
        clean_code("   ")


def test_avatar_strips_the_data_prefix():
    assert avatar_base64("data:image/png;base64,abcd") == "abcd"
    assert avatar_base64("") is None


def test_profile_rejects_an_unknown_color():
    assert profile_properties({"name": "Заявки", "color": "GREEN"})["color"] == "GREEN"
    with pytest.raises(ImbotError):
        profile_properties({"color": "NOPE"})


def test_v2_message_event():
    parsed = parse_v2_event(
        {
            "event": "ONIMBOTV2MESSAGEADD",
            "data": {
                "bot": {"id": "15"},
                "message": {"id": "90", "text": "Не печатает"},
                "chat": {"dialogId": "4"},
                "user": {"id": "4", "name": "Иван"},
            },
        }
    )
    assert parsed is not None
    assert parsed["text"] == "Не печатает"
    assert parsed["dialog_id"] == "4"
    assert parsed["message_id"] == "90"
    assert parsed["command"] == ""
    assert parse_v2_event({"event": "ONAPPINSTALL"}) is None


def test_legacy_message_event_reaches_the_same_chat():
    parsed = parse_v2_event(
        {
            "event": "ONIMBOTMESSAGEADD",
            "data": {
                "BOT": {"BOT_ID": "15"},
                "PARAMS": {
                    "MESSAGE": "Не печатает",
                    "DIALOG_ID": "4",
                    "FROM_USER_ID": "4",
                    "MESSAGE_ID": "90",
                    "CHAT_ID": "8",
                },
            },
        }
    )
    assert parsed is not None
    assert parsed["event"] == "ONIMBOTV2MESSAGEADD"
    assert parsed["text"] == "Не печатает"
    assert parsed["dialog_id"] == "4"
    assert parsed["bot_id"] == "15"
    assert dialog_candidates(parsed) == ["4", "chat8", "chat4"]


def test_profile_update_sends_the_name_without_event_mode():
    fields = profile_update_fields(
        {
            "name": "Новый",
            "last_name": "",
            "position": "Приём",
            "color": "GREEN",
            "gender": "",
            "hidden": False,
            "reactions": True,
            "openline": False,
            "background_id": "default",
            "event_mode": "fetch",
            "bot_type": "bot",
        }
    )
    assert fields["properties"]["name"] == "Новый"
    assert fields["properties"]["lastName"] == ""
    assert fields["properties"]["workPosition"] == "Приём"
    assert "eventMode" not in fields
    assert "type" not in fields
    assert "email" not in fields["properties"]
    assert clean_email("bot@example.com") == "bot@example.com"
    assert clean_email("  ") == ""
    assert legacy_email_body(15, "bot@example.com")["FIELDS"]["PROPERTIES"]["EMAIL"] == "bot@example.com"
    with pytest.raises(ImbotError):
        clean_email("not-an-email")
    assert fields["backgroundId"] is None


def test_bot_list_keeps_names_and_drops_nothing_secret():
    rows = public_bots(
        {
            "bots": [
                {
                    "id": 15,
                    "code": "support_bot",
                    "type": "bot",
                    "eventMode": "webhook",
                    "backgroundId": "mint",
                    "isHidden": False,
                    "isReactionsEnabled": False,
                    "isSupportOpenline": True,
                    "countMessage": 4,
                    "countChat": 2,
                    "countUser": 3,
                    "countCommand": 1,
                }
            ],
            "users": [{"id": 15, "name": "Заявки", "color": "GREEN", "bot": True}],
        }
    )
    assert rows[0]["name"] == "Заявки"
    assert rows[0]["event_mode"] == "webhook"
    assert rows[0]["color"] == "GREEN"
    assert rows[0]["background_id"] == "mint"
    assert rows[0]["reactions"] is False
    assert rows[0]["openline"] is True
    assert rows[0]["count_message"] == 4
    assert "token" not in rows[0]
    assert appearance_fields(
        {"hidden": True, "reactions": False, "openline": True, "background_id": "mint"}
    ) == {
        "isHidden": True,
        "isReactionsEnabled": False,
        "isSupportOpenline": True,
        "backgroundId": "mint",
    }
    assert delivery_fields("fetch") == {"eventMode": "fetch"}
    assert delivery_fields("webhook", "https://corax.example/handler")["webhookUrl"].endswith("/handler")
    assert delivery_fields("") == {}
    from types import SimpleNamespace

    assert wants_fetch(SimpleNamespace(bot_event_mode="fetch"))
    assert wants_fetch(SimpleNamespace(bot_event_mode=""))
    assert wants_fetch(SimpleNamespace(bot_event_mode=None)) is True
    assert wants_fetch(SimpleNamespace(bot_event_mode="webhook")) is False


def test_form_body_keeps_dialog_and_text():
    from app.routers.bitrix24_bot_handler import _payload_from_body

    parsed = parse_v2_event(
        _payload_from_body(
            "event=ONIMBOTV2MESSAGEADD"
            "&data[bot][id]=15"
            "&data[message][text]=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82"
            "&data[message][id]=9"
            "&data[chat][dialogId]=chat5"
            "&data[user][id]=4"
            "&data[user][name]=Ivan"
        )
    )
    assert parsed is not None
    assert parsed["text"] == "привет"
    assert parsed["dialog_id"] == "chat5"
    assert parsed["user_id"] == "4"
    assert intake_step(parsed["event"], parsed["command"], parsed["text"], enabled=True, waiting=False) == "nudge"


def test_fetch_event_uses_the_button_label():
    parsed = parse_fetch_event(
        {
            "eventId": 12,
            "type": "ONIMBOTV2MESSAGEADD",
            "data": {
                "message": {"id": 3, "text": "Оставить заявку"},
                "chat": {"dialogId": "chat5"},
                "user": {"id": 4, "name": "Иван"},
            },
        }
    )
    assert parsed is not None
    assert parsed["dialog_id"] == "chat5"
    assert parsed["from_bot"] == "0"
    assert intake_step(parsed["event"], "", parsed["text"], enabled=True, waiting=False) == "ask"
    assert next_offset({"hasMore": False}, [{"eventId": 12}]) == 13
    assert send_keyboard("Оставить заявку")[0]["ACTION"] == "SEND"
    menu = send_keyboard("Оставить заявку", "Мои заявки")
    assert keyboard_sig(menu) == "Оставить заявку|Мои заявки"
    assert keyboard_sig(None) == ""
    assert attach_keyboard(keyboard_sig(menu), menu) == menu
    assert attach_keyboard("", menu) == menu
    assert intake_step("ONIMBOTV2COMMANDADD", "ticket", "", enabled=True, waiting=False) == "ask"
    assert intake_step("ONIMBOTV2COMMANDADD", "/status", "", enabled=True, waiting=True) == "status"
    body = command_register_body(15, "token", "ticket", "Оставить заявку", "New ticket")
    assert body["fields"]["command"] == "ticket"
    assert body["fields"]["title"]["ru"] == "Оставить заявку"
    assert body["fields"]["hidden"] is False


def test_greeting_uses_the_name_and_the_time_of_day():
    morning = datetime(2026, 10, 26, 6, 0, tzinfo=timezone.utc)
    voice = BotVoice(greet_name=True, greet_daypart=True, greeting_note="Мы рядом.")
    text = greeting_text("Анна Петрова", voice, morning)
    assert text.startswith("Доброе утро, Анна!")
    assert "Мы рядом." in text
    quiet = greeting_text("Анна", BotVoice(greet_name=True, greet_daypart=False), morning)
    assert quiet.startswith("Здравствуйте!")
    assert "Анна" not in quiet
    closed = closed_text(12, name="Анна", status="done", voice=voice, moment=morning)
    assert closed.startswith("✅")
    assert "№12 выполнена" in closed
    assert "Хорошего утра, Анна" in closed
    assert "отменена" in closed_text(3, name="", status="cancelled", voice=BotVoice(greet_name=False, greet_daypart=False))
    evening = datetime(2026, 10, 26, 22, 0, tzinfo=timezone(timedelta(hours=9)))
    assert greeting_text("Анна", voice, evening).startswith("Добрый вечер, Анна!")


def test_applied_phrase_is_what_the_bot_says_next():
    from app.bot_intake import drop_phrases, phrases_for_bot, publish_phrases

    raw = dump_scripts({"15": {"ask": "старое"}})
    publish_phrases(15, {"ask": "Опишите, что сломалось."})
    try:
        voice = voice_from_phrases(
            phrases_for_bot(raw, 15, greet_daypart=True, greeting_note="", close_notice=True)
        )
        assert ask_text("Анна", voice) == "Опишите, что сломалось."
        publish_phrases(15, {})
        cleared = voice_from_phrases(
            phrases_for_bot(raw, 15, greet_daypart=True, greeting_note="", close_notice=True)
        )
        assert "одним сообщением" in ask_text("Анна", cleared)
    finally:
        drop_phrases(15)


def test_custom_phrase_replaces_only_that_line():
    morning = datetime(2026, 10, 26, 6, 0, tzinfo=timezone.utc)
    voice = voice_from_phrases({"ask": "Опишите проблему.", "accepted": "Заявка {id} создана.", "greet_body": "Слушаю."})
    assert ask_text("Анна", voice) == "Опишите проблему."
    assert "Слушаю." in greeting_text("Анна", voice, morning)
    assert "Я рядом" not in greeting_text("Анна", voice, morning)
    assert accepted_text(4, voice=voice) == "Заявка 4 создана."
    assert "Я рядом" in greeting_text("Анна", BotVoice(), morning)
    stored = dump_scripts({"15": {"ask": "  hi  ", "greet_daypart": False, "greeting_note": ""}})
    scripts = parse_scripts(stored)
    assert scripts["15"]["ask"] == "hi"
    assert scripts["15"]["greet_daypart"] is False
    assert "greeting_note" not in scripts["15"]


def test_ticket_waits_for_the_button():
    assert intake_step("ONIMBOTV2JOINCHAT", "", "", enabled=True, waiting=False) == "greet"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Оставить заявку", enabled=True, waiting=False) == "ask"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Не печатает", enabled=True, waiting=False) == "nudge"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Не печатает", enabled=True, waiting=True) == "take"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Статус заявки", enabled=True, waiting=True) == "status"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "статус заявки.", enabled=True, waiting=False) == "status"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Мои заявки", enabled=True, waiting=False) == "status"
    assert status_text(7, "[Битрикс] Не печатает", state="in_progress") == "🔧 Заявка №7 — в работе.\n[Битрикс] Не печатает"
    assert bitrix_title("Не печатает") == "[Битрикс] Не печатает"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Помощь", enabled=True, waiting=False) == "help"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Отмена", enabled=True, waiting=True) == "cancel"
    assert intake_step("ONIMBOTV2MESSAGEADD", "", "Не печатает", enabled=False, waiting=True) == "off"
