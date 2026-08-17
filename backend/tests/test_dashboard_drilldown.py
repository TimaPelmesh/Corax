from app.dashboard_drilldown import (
    build_segment_computer_row,
    computer_matches_segment,
    format_physical_disks_summary,
    ram_matches_bucket,
    system_model_matches_display,
)
from app.models import Computer


def test_ram_matches_bucket():
    assert ram_matches_bucket(15.8, "16 ГБ")
    assert ram_matches_bucket(None, "неизвестно")
    assert not ram_matches_bucket(8.0, "16 ГБ")


def test_system_model_matches_display():
    assert system_model_matches_display("OptiPlex 7090", "OptiPlex 7090")
    assert not system_model_matches_display("Other", "OptiPlex 7090")


def test_computer_matches_physical_disk():
    raw = '{"extended":{"physical_disks":[{"media_type":"SSD","size_gb":238.5}]}}'
    pc = Computer(hostname="pc1", raw_payload=raw)
    assert computer_matches_segment(pc, kind="physical_disk", name="SSD 240 ГБ")
    assert computer_matches_segment(pc, kind="physical_disk", name="SSD")
    assert format_physical_disks_summary(raw) == "SSD 240 ГБ"


def test_build_row_skips_lazy_user_and_null_hostname():
    pc = Computer(id=7, hostname=None, os_name="Microsoft Windows 10 Pro")
    row = build_segment_computer_row(pc, [])
    assert row["hostname"] == "#7"
    assert row["assigned_user_name"] is None
    assert row["os_summary"] == "Microsoft Windows 10 Pro"


def test_computer_matches_unknown_kind():
    pc = Computer(hostname="pc1", os_name="Windows 10")
    assert computer_matches_segment(pc, kind="nope", name="x") is False


def test_computer_matches_os_and_hostname():
    pc = Computer(id=3, hostname="LAB-01", os_name="Microsoft Windows 10 Pro")
    assert computer_matches_segment(pc, kind="os", name="Windows 10 Pro")
    assert not computer_matches_segment(pc, kind="os", name="Windows 7 Pro")
    assert computer_matches_segment(pc, kind="hostname", name="LAB-01")
    assert not computer_matches_segment(pc, kind="hostname", name="other")


def test_format_physical_disks_bad_payload():
    assert format_physical_disks_summary(None) is None
    assert format_physical_disks_summary("not-json") is None
    assert format_physical_disks_summary("{") is None
    assert format_physical_disks_summary("") is None


def test_build_row_coerces_bad_ram():
    pc = Computer(id=9, hostname="  ", ram_gb=None, os_name=None)
    row = build_segment_computer_row(pc, [])
    assert row["hostname"] == "#9"
    assert row["ram_gb"] is None
    assert row["os_summary"] is None
