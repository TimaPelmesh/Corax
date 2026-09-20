from types import SimpleNamespace

from app.wikirag_corax import (
    _relevant_csv_rows,
    build_fast_software_answer,
    build_inventory_analysis_hint,
    build_os_hardware_fallback_answer,
    pick_corax_level,
)
from app.wikirag_lm import classify_wikirag_question
from app.wikirag_content import context_keywords, excerpt_for_context


def test_classify_win10_question():
    assert classify_wikirag_question("кому лучше ставить 10 виндовс") == "os_hardware"


def test_pick_corax_level_hardware_not_micro_for_large_park():
    # OS/железо: парку ~40–120 ПК — medium (достаточно строк для 3B), не micro.
    level = pick_corax_level(103, has_imported_files=True, question="кому ставить win10")
    assert level == "medium"
    assert pick_corax_level(150, has_imported_files=True, question="кому ставить win10") == "compact"


def test_inventory_hint_lists_upgrade_candidates():
    pcs = [
        SimpleNamespace(
            hostname="PC-OLD",
            os_name="Microsoft Windows 7",
            os_version="6.1",
            ram_gb=8,
            tags=[],
        ),
        SimpleNamespace(
            hostname="PC-NEW",
            os_name="Microsoft Windows 10",
            os_version="22H2",
            ram_gb=16,
            tags=[],
        ),
        SimpleNamespace(
            hostname="PC-WEAK",
            os_name="Microsoft Windows 7",
            os_version="6.1",
            ram_gb=2,
            tags=[],
        ),
    ]
    data = {"computers": pcs}
    hint = build_inventory_analysis_hint(data, "кому лучше ставить windows 10")
    assert "PC-OLD" in hint
    assert "PC-NEW" in hint
    assert "Windows 7" in hint or "7" in hint
    assert "PC-WEAK" in hint


def test_os_hardware_fallback_answer():
    pcs = [
        SimpleNamespace(
            hostname="PC-OLD",
            os_name="Microsoft Windows 7",
            os_version="6.1",
            ram_gb=8,
            tags=[],
        ),
    ]
    data = {"computers": pcs}
    ans = build_os_hardware_fallback_answer(data, "кому ставить win10")
    assert "PC-OLD" in ans
    assert "Windows 10" in ans


def test_relevant_csv_rows_keeps_header_and_matching_hostname():
    csv_text = "computer_id;hostname;software_name\n1;PC-OLD;1C\n2;PC-NEW;Office\n"
    excerpt = _relevant_csv_rows(csv_text, "Что установлено на PC-NEW?", 10)
    assert excerpt.splitlines()[0] == "computer_id;hostname;software_name"
    assert "PC-NEW" in excerpt
    assert "PC-OLD" not in excerpt


def test_keyword_excerpt_prefers_matching_part_of_document():
    text = ("Введение. " * 300) + "Регламент для PC-77: перезагрузите службу." + (" Конец." * 300)
    excerpt = excerpt_for_context(text, 180, query="Что делать с PC-77?")
    assert "PC-77" in excerpt
    assert "pc-77" in context_keywords("Что делать с PC-77?")


def test_fast_software_answer_lists_computers_without_software():
    pcs = [
        SimpleNamespace(hostname="PC-DRWEB", software=[SimpleNamespace(name="Dr.Web Agent")]),
        SimpleNamespace(hostname="PC-NO-AV", software=[SimpleNamespace(name="Office")]),
    ]
    answer = build_fast_software_answer({"computers": pcs}, "У кого нет Dr.Web?")
    assert "1 из 2" in answer
    assert "PC-NO-AV" in answer
    assert "PC-DRWEB" not in answer
