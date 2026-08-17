from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


def _emit_mod():
    path = Path(__file__).resolve().parents[2] / "agent" / "linux" / "lib" / "emit_report.py"
    if not path.is_file():
        pytest.skip("linux agent emit_report.py missing")
    spec = importlib.util.spec_from_file_location("corax_linux_emit_report", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_meta_float_accepts_locale_comma(tmp_path: Path):
    emit = _emit_mod()
    meta = tmp_path / "meta"
    meta.mkdir()
    (meta / "ram_gb").write_text("16,00", encoding="utf-8")
    assert emit.meta_float(tmp_path, "ram_gb") == 16.0


def test_meta_float_reads_c_locale(tmp_path: Path):
    emit = _emit_mod()
    meta = tmp_path / "meta"
    meta.mkdir()
    (meta / "ram_gb").write_text("15.61", encoding="utf-8")
    assert emit.meta_float(tmp_path, "ram_gb") == pytest.approx(15.61)


def test_build_includes_ram_and_board(tmp_path: Path):
    emit = _emit_mod()
    meta = tmp_path / "meta"
    meta.mkdir()
    (meta / "hostname").write_text("linux-pc", encoding="utf-8")
    (meta / "ram_gb").write_text("32.00", encoding="utf-8")
    (meta / "motherboard_manufacturer").write_text("ASUSTeK COMPUTER INC.", encoding="utf-8")
    (meta / "motherboard_product").write_text("PRIME B550-PLUS", encoding="utf-8")
    (tmp_path / "disks.tsv").write_text("", encoding="utf-8")
    (tmp_path / "software.tsv").write_text("", encoding="utf-8")
    (tmp_path / "peripherals.tsv").write_text("", encoding="utf-8")
    payload = emit.build(tmp_path)
    assert payload["ram_gb"] == 32.0
    assert payload["motherboard_manufacturer"] == "ASUSTeK COMPUTER INC."
    assert payload["motherboard_product"] == "PRIME B550-PLUS"
