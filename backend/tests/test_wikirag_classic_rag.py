from app.wikirag_index import recursive_character_split
from app.wikirag_lm import build_messages, classify_wikirag_question, is_small_talk


def test_recursive_split_matches_script_defaults():
    text = ("Параграф один про принтеры HP.\n\n" * 40) + ("Параграф два про CORAX.\n\n" * 40)
    chunks = recursive_character_split(text, size=1500, overlap=300)
    assert len(chunks) >= 2
    assert all(len(c) <= 1800 for c in chunks)  # overlap can slightly inflate


def test_recursive_split_small_chunks_still_works():
    text = ("Параграф один про принтеры HP.\n\n" * 40) + ("Параграф два про CORAX.\n\n" * 40)
    chunks = recursive_character_split(text, size=500, overlap=100)
    assert len(chunks) >= 2
    assert all(len(c) <= 650 for c in chunks)


def test_classify_installed_software_not_hardware():
    assert classify_wikirag_question("У кого установлено Chrome?") == "software"
    assert classify_wikirag_question("кому ставить windows 10") == "os_hardware"


def test_inventory_questions_are_not_small_talk():
    assert is_small_talk("привет") is True
    assert is_small_talk("топ слабых") is False
    assert is_small_talk("сколько ПК") is False
    assert is_small_talk("у кого принтер") is False


def test_classic_prompt_allows_reasoned_fallback():
    msgs = build_messages(
        "Какой IP у HP M402?",
        "### printers.md\n- **IP:** 192.168.3.21",
        [],
        mode="rag",
    )
    user = msgs[-1]["content"]
    assert "ИСКЛЮЧИТЕЛЬНО" not in user
    assert "базе знаний" in user.lower() or "контекст" in user.lower()
    assert "192.168.3.21" in user
    assert "Контекст:" in user
    system = msgs[0]["content"]
    assert "прямого ответа" in system.lower()
    assert "вывод" in system.lower()
