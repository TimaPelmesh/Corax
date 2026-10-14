from app.wikirag_index import recursive_character_split
from app.wikirag_lm import build_messages, classify_wikirag_question, is_small_talk, retrieval_question


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
    assert classify_wikirag_question("какой шлюз в сети") == "network"
    assert classify_wikirag_question("где коммутатор cisco") == "network"


def test_inventory_questions_are_not_small_talk():
    assert is_small_talk("привет") is True
    assert is_small_talk("топ слабых") is False
    assert is_small_talk("сколько ПК") is False
    assert is_small_talk("у кого принтер") is False


def test_classic_prompt_allows_reasoned_fallback(monkeypatch):
    monkeypatch.setattr("app.wikirag_options.get_system_prompt", lambda: "")
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
    assert "контекст" in system.lower()
    assert "не выдумывай" in system.lower()
    assert "расчёт" in system.lower()
    assert "следователь" in system.lower()
    assert "готовая фраза" not in user.lower() or "кому стоит" in user.lower()


def test_nudge_keeps_the_original_task_for_search():
    history = [
        {
            "role": "user",
            "content": "есть одна лицензия и новое железо, кому стоит обновить",
        },
        {"role": "assistant", "content": "В контексте нет информации."},
    ]
    q = retrieval_question("ну так сам подумай ты же исследователь", history)
    assert "лицензия" in q
    assert "железо" in q
    assert classify_wikirag_question(q) == "os_hardware"
    assert retrieval_question("у кого Windows 7", history) == "у кого Windows 7"


def test_custom_system_prompt_is_what_the_model_sees(tmp_path, monkeypatch):
    from app.wikirag_options import set_system_prompt

    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_dir", str(tmp_path))
    set_system_prompt("Считай статистику по всем ПК из контекста. Не отказывайся.")
    msgs = build_messages("а у остальных ПК что?", "PC-2 Windows 7\nPC-3 Windows 10", [], mode="rag")
    assert msgs[0]["content"].startswith("Считай статистику")
    assert "кому стоит" not in msgs[-1]["content"]
    assert "PC-3" in msgs[-1]["content"]
    set_system_prompt("")
    cleared = build_messages("кто на win7", "PC-1", [], mode="rag")
    assert "не выдумывай" in cleared[0]["content"].lower()
