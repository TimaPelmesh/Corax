from app.physical_disks import (
    aggregate_physical_disks,
    disk_rows_from_payload_data,
    disk_size_label,
    filter_report_disk_rows,
    normalize_media_type,
)


def test_normalize_media_type():
    assert normalize_media_type("SSD") == "SSD"
    assert normalize_media_type("hdd") == "HDD"
    assert normalize_media_type("Unspecified") == "Другой"
    assert normalize_media_type("logical") == "Том"
    assert normalize_media_type(None) == "Неизвестно"


def test_disk_size_label_snaps_common_sizes():
    assert disk_size_label(238.5) == "240 ГБ"
    assert disk_size_label(465.8) == "480 ГБ"
    assert disk_size_label(931.5) == "1000 ГБ"
    assert disk_size_label(None) == "неизвестно"


def test_aggregate_physical_disks_v3():
    raw = [
        '{"extended":{"physical_disks":[{"media_type":"SSD","size_gb":238.5},{"media_type":"HDD","size_gb":931.5}]}}',
        '{"extended":{"physical_disks":[{"media_type":"SSD","size_gb":476.9}]}}',
    ]
    total, by_media, by_size, by_variant = aggregate_physical_disks(raw)
    assert total == 3
    assert by_media["SSD"] == 2
    assert by_media["HDD"] == 1
    assert by_variant["SSD 240 ГБ"] == 1
    assert by_variant["SSD 480 ГБ"] == 1
    assert by_variant["HDD 1000 ГБ"] == 1


def test_aggregate_physical_disks_v2_logical_fallback():
    raw = [
        '{"disks":[{"mount":"C:","total_gb":237.5,"used_percent":55},{"mount":"D:","total_gb":931.2,"used_percent":10}]}',
    ]
    total, by_media, _, by_variant = aggregate_physical_disks(raw)
    assert total == 2
    assert by_media["Том"] == 2
    assert by_variant["Том 240 ГБ"] == 1
    assert by_variant["Том 1000 ГБ"] == 1


def test_v3_prefers_physical_over_logical():
    raw = [
        '{"disks":[{"mount":"C:","total_gb":500}],"extended":{"physical_disks":[{"media_type":"SSD","size_gb":476.9}]}}',
    ]
    rows = disk_rows_from_payload_data(__import__("json").loads(raw[0]))
    assert len(rows) == 1
    assert rows[0]["media_type"] == "SSD"


def test_filter_small_recovery_partitions():
    rows = [
        {"media_type": "SSD", "size_gb": 238.0},
        {"media_type": "Unspecified", "size_gb": 7.0},
    ]
    filtered = filter_report_disk_rows(rows)
    assert len(filtered) == 1
    assert filtered[0]["media_type"] == "SSD"
