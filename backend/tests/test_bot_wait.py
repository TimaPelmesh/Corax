"""The ticket bot speaks once, then waits. Echoes must not send another bubble."""

from app.bot_intake import ChatWait, decide_chat, note_sent


def _play(events, start=None):
    state = start or ChatWait()
    sent = []
    for event, text, message_id, now in events:
        action, state = decide_chat(
            event,
            text,
            "",
            message_id=message_id,
            state=state,
            now=now,
        )
        if action != "quiet":
            sent.append(action)
            state = note_sent(state, text if action != "greet" else "Я бот заявок. Нажмите кнопку или напишите.")
        if action == "greet":
            state = note_sent(state, "Я бот заявок. Нажмите кнопку или напишите.")
    return sent, state


def test_join_greets_once_and_then_waits():
    sent, state = _play(
        [
            ("ONIMBOTV2JOINCHAT", "", "1", 0.0),
            ("ONIMBOTV2JOINCHAT", "", "2", 0.2),
            ("ONIMBOTV2JOINCHAT", "", "3", 1.0),
        ]
    )
    assert sent == ["greet"]
    assert state.greeted is True


def test_the_first_button_press_is_enough():
    sent, _state = _play(
        [
            ("ONIMBOTV2JOINCHAT", "", "1", 0.0),
            ("ONIMBOTV2MESSAGEADD", "Оставить заявку", "2", 0.2),
        ]
    )
    assert sent == ["greet", "ask"]


def test_same_message_and_own_bubble_are_not_sent_again():
    state = ChatWait()
    action, state = decide_chat("ONIMBOTV2JOINCHAT", "", "", message_id="9", state=state, now=0.0)
    assert action == "greet"
    body = "Я бот заявок. Нажмите кнопку или напишите."
    state = note_sent(state, body)
    again, state = decide_chat("ONIMBOTV2JOINCHAT", "", "", message_id="9", state=state, now=0.5)
    assert again == "quiet"
    echo, state = decide_chat("ONIMBOTV2MESSAGEADD", body, "", message_id="10", state=state, now=0.6)
    assert echo == "quiet"
    own, _state = decide_chat(
        "ONIMBOTV2MESSAGEADD",
        "ещё раз",
        "",
        message_id="11",
        from_bot=True,
        state=state,
        now=1.0,
    )
    assert own == "quiet"


def test_one_press_then_text_and_no_duplicate():
    action, state = decide_chat("ONIMBOTV2JOINCHAT", "", "", message_id="1", now=0.0)
    assert action == "greet"
    state = note_sent(state, "приветствие")
    pressed, state = decide_chat(
        "ONIMBOTV2MESSAGEADD",
        "Оставить заявку",
        "",
        message_id="2",
        state=state,
        now=0.3,
    )
    assert pressed == "ask"
    ask = "Напишите, пожалуйста, одним сообщением."
    state = note_sent(state, ask)
    echo, state = decide_chat("ONIMBOTV2MESSAGEADD", ask, "", message_id="3", state=state, now=0.4)
    assert echo == "quiet"
    typed, state = decide_chat(
        "ONIMBOTV2MESSAGEADD",
        "Не печатает",
        "",
        message_id="4",
        state=state,
        now=1.0,
    )
    assert typed == "take"
    duplicate, _state = decide_chat(
        "ONIMBOTV2MESSAGEADD",
        "Не печатает",
        "",
        message_id="4",
        state=state,
        now=1.1,
    )
    assert duplicate == "quiet"
