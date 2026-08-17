from types import SimpleNamespace

from app.wikirag_corax import (
    CORAX_BUNDLE_FILENAMES,
    CORAX_COMPUTERS_MD,
    CORAX_FOLDER,
    CORAX_HARDWARE_MD,
    CORAX_INDEX_FILENAME,
    CORAX_NETWORK_MD,
    CORAX_PARK_STATS_MD,
    CORAX_SOFTWARE_MD,
    CORAX_SOFTWARE_STATS_MD,
    CORAX_USERS_MD,
    build_corax_file_bundle,
)
from app.wikirag_index import chunk_corax_markdown, prepare_document_chunks


def _sample_data():
    tag = SimpleNamespace(id=1, name="Бухгалтерия")
    pc = SimpleNamespace(
        id=7,
        hostname="PC-ACC-01",
        location="Офис 2",
        assigned_user_id=1,
        ip_address="192.168.1.50",
        serial_number="SN-1",
        mac_primary="AA:BB",
        manufacturer="Dell",
        model="OptiPlex",
        cpu="i5-8500",
        ram_gb=16,
        gpu_name="UHD 630",
        os_name="Windows 10",
        os_version="22H2",
        memory_used_percent=40,
        last_report_at=None,
        notes="тест",
        tags=[tag],
        software=[SimpleNamespace(name="1C:Enterprise", version="8.3")],
        peripherals=[SimpleNamespace(kind="monitor", name="Dell P2419H")],
        disks_json=None,
        motherboard_manufacturer="Dell",
        motherboard_product="0XYZ",
    )
    user = SimpleNamespace(
        id=1,
        username="ivan",
        full_name="Иван",
        email="ivan@example.com",
        role="editor",
        is_active=True,
    )
    net = SimpleNamespace(
        id=3,
        hostname="sw-core",
        sys_name="SW-CORE",
        ip_address="192.168.1.1",
        device_type="switch",
        vendor="Cisco",
        location="Серверная",
        snmp_status="ok",
        source="snmp",
        sys_descr="Catalyst",
        notes=None,
        last_snmp_at=None,
        last_seen_at=None,
    )
    return {
        "users": {1: user},
        "tags": [tag],
        "computers": [pc],
        "disks_by_pc": {},
        "printers": [],
        "network_devices": [net],
        "network_links": [],
        "requests": [],
        "templates": [],
        "categories": [],
        "pc_by_id": {7: pc},
    }


def test_corax_bundle_lives_under_inventory_folder():
    bundle = build_corax_file_bundle(_sample_data())
    assert set(CORAX_BUNDLE_FILENAMES) == set(bundle.keys())
    assert CORAX_INDEX_FILENAME == "00_system_index.md"
    assert CORAX_INDEX_FILENAME in bundle
    assert not CORAX_INDEX_FILENAME.startswith(f"{CORAX_FOLDER}/")
    assert all(
        name == CORAX_INDEX_FILENAME or name.startswith(f"{CORAX_FOLDER}/") for name in bundle
    )
    assert "Карта файлов" in bundle[CORAX_INDEX_FILENAME] or "карта файлов" in bundle[CORAX_INDEX_FILENAME].lower()
    assert "корне" in bundle[CORAX_INDEX_FILENAME].lower()

    computers = bundle[CORAX_COMPUTERS_MD]
    hardware = bundle[CORAX_HARDWARE_MD]
    software = bundle[CORAX_SOFTWARE_MD]
    stats = bundle[CORAX_SOFTWARE_STATS_MD]
    park = bundle[CORAX_PARK_STATS_MD]
    users = bundle[CORAX_USERS_MD]
    network = bundle[CORAX_NETWORK_MD]

    assert "## PC-ACC-01 (computer_id=7)" in computers
    assert "192.168.1.50" in computers
    assert "Windows 10" in computers
    assert "i5-8500" in hardware
    assert "Dell P2419H" in hardware
    assert "1C:Enterprise" in software
    assert "## 1C:Enterprise" in stats
    assert "PC-ACC-01" in stats
    assert "Статистика парка" in park
    assert "Windows 10" in park
    assert "Шлюзы" in park or "gateway" in park.lower()
    assert "ПК в ответственности" in users
    assert "1C:Enterprise" in users
    assert "## sw-core (network_id=3)" in network
    assert "192.168.1.1" in network
    assert "Роль" in network or "Сводка по ролям" in network
    assert CORAX_PARK_STATS_MD in bundle
    assert "CORAX_статистика.md" in bundle[CORAX_INDEX_FILENAME]

def test_chunk_corax_markdown_keeps_hostname_metadata():
    md = """# Железо

## PC-ACC-01 (computer_id=7)

- **CPU:** i5-8500
"""
    chunks = chunk_corax_markdown(md, source_table="hardware", filename="CORAX_железо.md")
    assert chunks
    host_chunks = [c for c in chunks if c.hostname == "PC-ACC-01"]
    assert host_chunks
    assert host_chunks[0].computer_id == 7


def test_prepare_chunks_for_folder_path():
    md = """# ПО

## PC-ACC-01 (computer_id=7)

- Chrome
"""
    chunks = prepare_document_chunks(
        f"{CORAX_FOLDER}/CORAX_ПО.md",
        "text",
        md,
    )
    assert chunks
    host_chunks = [c for c in chunks if c.source_table == "software" and c.hostname == "PC-ACC-01"]
    assert host_chunks
