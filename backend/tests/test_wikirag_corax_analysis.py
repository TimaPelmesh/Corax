from types import SimpleNamespace

from app.wikirag_corax import (
    build_inventory_analysis_hint,
    build_os_hardware_fallback_answer,
    pick_corax_level,
)
from app.wikirag_lm import classify_wikirag_question


def test_classify_win10_question():
    assert classify_wikirag_question("кому лучше ставить 10 виндовс") == "os_hardware"


def test_pick_corax_level_hardware_not_micro_for_large_park():
    level = pick_corax_level(103, has_imported_files=True, question="кому ставить win10")
    assert level == "compact"


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
