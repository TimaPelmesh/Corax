"""OEM / motherboard display helpers (no DB)."""

from __future__ import annotations

from app.oem_normalize import (
    aggregate_manufacturer_counts,
    aggregate_motherboard_counts,
    is_placeholder_wmi_value,
    motherboard_display_label,
    manufacturer_display_label,
    normalize_manufacturer,
    normalize_system_model,
)


def test_placeholder_wmi_values():
    assert is_placeholder_wmi_value(None)
    assert is_placeholder_wmi_value("")
    assert is_placeholder_wmi_value("To Be Filled By O.E.M.")
    assert is_placeholder_wmi_value("System Manufacturer")
    assert not is_placeholder_wmi_value("Dell Inc.")


def test_normalize_manufacturer_canonical_and_suffix_strip():
    assert normalize_manufacturer("ASUSTeK COMPUTER INC.") == "ASUS"
    assert normalize_manufacturer("Hewlett-Packard") == "HP"
    assert normalize_manufacturer("Alienware") == "Dell"
    assert normalize_manufacturer("Acme Corp.") == "Acme"
    assert normalize_manufacturer("System Manufacturer") is None


def test_manufacturer_display_falls_back_to_unknown_label():
    assert manufacturer_display_label(None) == "Не указано"
    assert manufacturer_display_label("Lenovo") == "Lenovo"


def test_normalize_system_model_collapses_whitespace():
    assert normalize_system_model("  OptiPlex   7090  ") == "OptiPlex 7090"
    assert normalize_system_model("System Product Name") is None


def test_motherboard_display_label_joins_parts():
    assert motherboard_display_label("ASUS", "PRIME B450-PLUS") == "ASUS · PRIME B450-PLUS"
    assert motherboard_display_label(None, "PRIME B450-PLUS") == "PRIME B450-PLUS"
    assert motherboard_display_label("Dell Inc.", None) == "Dell"
    assert motherboard_display_label(None, None) == "Не указано"


def test_aggregate_manufacturer_counts_merges_aliases():
    rows = [
        ("Dell Inc.", 2),
        ("Dell", 1),
        ("To Be Filled By O.E.M.", 4),
        ("Lenovo", 1),
    ]
    assert aggregate_manufacturer_counts(rows, limit=2) == [
        ("Не указано", 4),
        ("Dell", 3),
    ]


def test_aggregate_motherboard_counts_orders_by_count():
    rows = [
        ("ASUS", "A", 1),
        ("ASUS", "A", 2),
        ("MSI", "B", 5),
    ]
    assert aggregate_motherboard_counts(rows) == [
        ("MSI · B", 5),
        ("ASUS · A", 3),
    ]
