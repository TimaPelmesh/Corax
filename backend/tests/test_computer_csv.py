from __future__ import annotations

import pytest

from app.routers.computers import _csv_cell, _parse_glpi_pc_dt, _pc_csv_reader


def test_pc_csv_reader_accepts_minimal_glpi_export():
    reader, columns = _pc_csv_reader("Наименование;Производитель\nPC-01;Dell\n")
    row = next(reader)

    assert _csv_cell(row, columns["name"]) == "PC-01"
    assert _csv_cell(row, columns["manufacturer"]) == "Dell"
    assert columns["cpu"] is None


def test_pc_csv_reader_accepts_corax_comma_export():
    reader, columns = _pc_csv_reader(
        "hostname,location,os_name,serial_number,last_report_at,notes\n"
        'PC-02,"Office, 2nd floor",Windows 11,SN-42,2026-08-16T10:20:30Z,Imported\n'
    )
    row = next(reader)

    assert _csv_cell(row, columns["name"]) == "PC-02"
    assert _csv_cell(row, columns["org"]) == "Office, 2nd floor"
    assert _csv_cell(row, columns["inv"]) == "SN-42"
    assert _csv_cell(row, columns["notes"]) == "Imported"


def test_pc_csv_reader_accepts_extended_glpi_column_names():
    reader, columns = _pc_csv_reader(
        "Наименование\tКомпоненты - Процессоры - Наименование\nPC-03\tRyzen 7\n"
    )
    row = next(reader)

    assert _csv_cell(row, columns["name"]) == "PC-03"
    assert _csv_cell(row, columns["cpu"]) == "Ryzen 7"


def test_pc_csv_reader_reports_only_missing_identity_column():
    with pytest.raises(ValueError, match="колонка с именем ПК"):
        _pc_csv_reader("Статус;Модель\nРабочий;OptiPlex\n")


def test_pc_csv_date_accepts_glpi_and_iso_formats():
    assert _parse_glpi_pc_dt("16-08-2026 10:20") is not None
    assert _parse_glpi_pc_dt("2026-08-16T10:20:30Z") is not None
