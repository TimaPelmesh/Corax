from types import SimpleNamespace

from app.wikirag_corax import (
    CORAX_BUNDLE_FILENAMES,
    CORAX_COMPUTERS_MD,
    CORAX_DASHBOARD_MD,
    CORAX_FOLDER,
    CORAX_HARDWARE_MD,
    CORAX_INDEX_FILENAME,
    CORAX_MONITORS_MD,
    CORAX_NETWORK_MD,
    CORAX_NOTES_MD,
    CORAX_PARK_STATS_MD,
    CORAX_PRINTERS_MD,
    CORAX_RISKS_MD,
    CORAX_SOFTWARE_MD,
    CORAX_SOFTWARE_STATS_MD,
    CORAX_USERS_MD,
    CORAX_WAREHOUSE_MD,
    CORAX_ZABBIX_MD,
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
        software=[
            SimpleNamespace(name="1C:Enterprise", version="8.3"),
            SimpleNamespace(name="Google Chrome", version="128"),
        ],
        peripherals=[SimpleNamespace(kind="monitor", name="Dell P2419H")],
        disks_json=None,
        motherboard_manufacturer="Dell",
        motherboard_product="0XYZ",
        ping_status="online",
        last_ping_at=None,
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
        sys_object_id=None,
        snmp_error=None,
        interfaces_json='[{"name":"Gi1/0/1","oper_status":"up","mac":"aa:bb:cc:dd:ee:01"}]',
        neighbors_json='[{"remote_name":"PC-ACC-01","remote_ip":"192.168.1.50","local_port":"Gi1/0/1"}]',
        fdb_json=None,
        extras_json='{"model":"Catalyst 2960","community":"secret-community"}',
    )
    printer = SimpleNamespace(
        id=11,
        name="HP LaserJet 400",
        computer_id=7,
        ip_address="192.168.1.20",
        location="Офис 2",
        driver_name="HP Universal",
        snmp_model="HP LaserJet 400",
        is_network=True,
        is_shared=True,
        is_default=False,
        notes=None,
        port_name="IP_192.168.1.20",
        printer_kind="laser",
        serial_number="PR-1",
        snmp_sys_name="HP400",
        source="snmp",
        agent_status=None,
        work_offline=False,
        poll_status="ok",
        snmp_status="ok",
        snmp_error=None,
        page_count=12000,
        supplies_json='[{"name":"Black Toner","level_percent":8,"level_raw":80,"max_capacity":1000}]',
        last_snmp_at=None,
        last_poll_at=None,
        last_seen_at=None,
    )
    monitor = SimpleNamespace(
        id=2,
        name="Dell P2419H",
        manufacturer="Dell",
        model="P2419H",
        serial_number="M-1",
        inventory_number="INV-9",
        organization=None,
        assigned_user_id=1,
        glpi_contact_raw=None,
        glpi_updated_at=None,
    )
    return {
        "users": {1: user},
        "tags": [tag],
        "computers": [pc],
        "disks_by_pc": {},
        "printers": [printer],
        "network_devices": [net],
        "network_links": [
            SimpleNamespace(
                from_type="network_device",
                from_id=3,
                to_type="computer",
                to_id=7,
                link_type="lldp",
                local_port="Gi1/0/1",
                remote_port="eth0",
                confidence=1.0,
            )
        ],
        "requests": [],
        "templates": [],
        "categories": [],
        "monitors": [monitor],
        "notes": [],
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
    assert "Gi1/0/1" in network
    assert "PC-ACC-01" in network
    assert "secret-community" not in network
    assert "Catalyst 2960" in network
    assert CORAX_PARK_STATS_MD in bundle
    assert "CORAX_статистика.md" in bundle[CORAX_INDEX_FILENAME]
    assert "CORAX_дашборд.md" in bundle[CORAX_INDEX_FILENAME]

    dashboard = bundle[CORAX_DASHBOARD_MD]
    printers_md = bundle[CORAX_PRINTERS_MD]
    assert "Дашборд" in dashboard
    assert "Google Chrome" in dashboard
    assert "Сигналы" in dashboard
    assert "HP LaserJet 400" in printers_md
    assert "тонер" in printers_md.lower() or "Black Toner" in printers_md
    assert "8" in printers_md
    assert bundle[CORAX_ZABBIX_MD]
    assert "монитор" in bundle[CORAX_MONITORS_MD].lower() or "Dell P2419H" in bundle[CORAX_MONITORS_MD]
    assert "склад" in bundle[CORAX_WAREHOUSE_MD].lower()
    assert "риск" in bundle[CORAX_RISKS_MD].lower()
    assert "заметк" in bundle[CORAX_NOTES_MD].lower()

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


def test_prepare_chunks_for_dashboard_and_printers():
    dash = prepare_document_chunks(
        f"{CORAX_FOLDER}/CORAX_дашборд.md",
        "text",
        "# Дашборд\n\n## Сигналы\n\n- Офлайн: **0**\n",
    )
    assert dash
    assert any(c.source_table == "dashboard" for c in dash)

    pr = prepare_document_chunks(
        f"{CORAX_FOLDER}/CORAX_принтеры.md",
        "text",
        "# Принтеры\n\n## HP LaserJet 400 (printer_id=11)\n\n- **Hostname ПК:** PC-ACC-01\n",
    )
    assert pr
    host_chunks = [c for c in pr if c.hostname == "PC-ACC-01"]
    assert host_chunks
