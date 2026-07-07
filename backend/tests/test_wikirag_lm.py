from app.wikirag_lm import (
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

