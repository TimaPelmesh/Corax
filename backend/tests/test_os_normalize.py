from app.os_normalize import (
    aggregate_os_counts,
    correct_windows_11_name,
    normalize_os_display,
    os_matches_display,
)


def test_normalize_os_short_pro():
    assert normalize_os_display("Microsoft Windows 7 Professional") == "Windows 7 Pro"
    assert normalize_os_display("Microsoft Windows 7 Профессиональная") == "Windows 7 Pro"
    assert normalize_os_display("Windows 10 Pro") == "Windows 10 Pro"
    assert normalize_os_display("Microsoft Windows 10 Pro") == "Windows 10 Pro"
    assert os_matches_display("Microsoft Windows 7 Профессиональная", "Windows 7 Pro")


def test_normalize_os_enterprise_and_home():
    assert normalize_os_display("Windows 10 Корпоративная") == "Windows 10 Ent"
    assert normalize_os_display("Windows 10 Enterprise") == "Windows 10 Ent"
    assert normalize_os_display("Windows 7 Домашняя расширенная") == "Windows 7 Home Prem"
    assert normalize_os_display("Windows 7 Home Premium") == "Windows 7 Home Prem"


def test_normalize_os_empty_and_unknown():
    assert normalize_os_display(None) == "Неизвестно"
    assert normalize_os_display("   ") == "Неизвестно"
    assert os_matches_display(None, "Неизвестно")
    assert not os_matches_display("", "Windows 10 Pro")


def test_windows_11_is_not_labeled_as_windows_10():
    assert correct_windows_11_name("Windows 10 Pro", "10.0.26100 build 26100") == "Windows 11 Pro"
    assert correct_windows_11_name("Windows 10 Корпоративная", "10.0.22631 build 22631") == "Windows 11 Корпоративная"
    assert correct_windows_11_name("Windows 10 Pro", "10.0.19045 build 19045") == "Windows 10 Pro"
    assert correct_windows_11_name("Windows 11 Pro", "10.0.22621 build 22621") == "Windows 11 Pro"
    assert correct_windows_11_name("Windows Server 2022", "10.0.20348 build 20348") == "Windows Server 2022"
    assert correct_windows_11_name("Windows 10 Pro", None, family="win11") == "Windows 11 Pro"


def test_aggregate_os_counts_merges_locales():
    rows = [
        ("Microsoft Windows 7 Professional", 3),
        ("Microsoft Windows 7 Профессиональная", 2),
        ("Windows 10 Pro", 1),
    ]
    merged = aggregate_os_counts(rows)
    by_name = dict(merged)
    assert by_name["Windows 7 Pro"] == 5
    assert by_name["Windows 10 Pro"] == 1
