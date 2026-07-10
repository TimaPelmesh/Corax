from app.wikirag_lm import (
    _append_no_think_hint,
    _has_reasoning_only,
    _looks_like_reasoning_dump,
    _message_text_from_lm,
    _sanitize_model_output,
    _strip_think_blocks,
    coerce_parsed,
    extract_answer_text,
    is_bad_lm_answer,
)

def test_extract_plain_text_unchanged():
    raw = "На ПК IVANOV установлен 1С:Предприятие."
    assert extract_answer_text(raw) == raw


def test_extract_json_answer():
    raw = '{"answer": "Да, есть.", "confidence": "high"}'
    assert extract_answer_text(raw) == "Да, есть."


def test_extract_empty_json_falls_back_to_raw():
    raw = '{"note": "только метаданные"}'
    assert extract_answer_text(raw) == raw


def test_strip_think_blocks():
    open_t = "<" + "think>"
    close_t = "</" + "think>"
    raw = f"{open_t}размышления{close_t}\nИтоговый ответ."
    assert _strip_think_blocks(raw) == "Итоговый ответ."


def test_message_text_prefers_content_over_reasoning():
    msg = {
        "content": "Ответ пользователю.",
        "reasoning_content": "длинные размышления",
    }
    assert _message_text_from_lm(msg) == "Ответ пользователю."


def test_message_text_empty_content_english_reasoning_is_empty():
    """Gemma-style: content='', reasoning truncated mid-CoT → no usable answer."""
    msg = {
        "content": "",
        "reasoning_content": (
            "Here's a thinking process to arrive at the desired output:\n\n"
            "1. Analyze the Request: The user wants who should be prioritized "
            "for upgrading to Windows 10, based on the provided CO"
        ),
    }
    assert _message_text_from_lm(msg) == ""
    assert _has_reasoning_only(msg)


def test_message_text_salvages_russian_from_reasoning():
    msg = {
        "content": "",
        "reasoning_content": (
            "Here's a thinking process to construct the suggested response:\n\n"
            "1. Analyze the Request: The user wants Windows 10 recommendations.\n\n"
            "**Вывод:** ПК PC-OLD на Windows 7 — кандидат на миграцию.\n"
            "Hostname PC-NEW уже на Windows 10."
        ),
    }
    out = _message_text_from_lm(msg)
    assert "PC-OLD" in out
    assert "thinking process" not in out.lower()


def test_append_no_think_hint_on_last_user():
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "Кому ставить Win10?"},
    ]
    out = _append_no_think_hint(msgs)
    assert "thinking process" in out[-1]["content"].lower()
    assert out[-1]["content"].startswith("Кому ставить Win10?")


def test_coerce_parsed_never_empty_placeholder_on_raw():
    out = coerce_parsed("Простой ответ.")
    assert out["answer"] == "Простой ответ."


def test_strip_english_reasoning_dump():
    raw = (
        "Here's a thinking process to construct the suggested response:\n\n"
        "1. Analyze the Request: The user wants Windows 10 recommendations.\n"
        "2. Since no data is provided, I must assume...\n\n"
        "**Вывод:** ПК PC-OLD на Windows 7 — кандидат на миграцию.\n"
        "Hostname PC-NEW уже на Windows 10."
    )
    assert _looks_like_reasoning_dump(raw)
    cleaned = _sanitize_model_output(raw)
    assert "thinking process" not in cleaned.lower()
    assert "PC-OLD" in cleaned


def test_is_bad_lm_answer_detects_reasoning():
    assert is_bad_lm_answer("Here's a thinking process to construct the response")
    assert not is_bad_lm_answer("Рекомендую обновить PC-OLD с Windows 7 на Windows 10.")

