from app.dashboard_drilldown import (
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
    assert format_physical_disks_summary(raw) == "SSD 240 ГБ"
