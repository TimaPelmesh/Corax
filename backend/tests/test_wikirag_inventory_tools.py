from app.wikirag_tools import (
    _extract_pc_filters,
    _pc_aggregates,
    _pc_matches_filters,
    merge_pc_filters,
    needs_live_inventory_tools,
)


class _FakeSw:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakePc:
    def __init__(self, **kwargs) -> None:
        self.hostname = kwargs.get("hostname", "PC-1")
        self.os_name = kwargs.get("os_name")
        self.os_version = kwargs.get("os_version")
        self.ram_gb = kwargs.get("ram_gb")
        self.cpu = kwargs.get("cpu")
        self.location = kwargs.get("location")
        self.tags = []
        self.software = [_FakeSw(n) for n in kwargs.get("software", [])]


def test_needs_live_for_park_and_tickets():
    assert needs_live_inventory_tools("какие ПК на Win10", "os_hardware")
    assert needs_live_inventory_tools("анализ открытых заявок", "tickets")
    assert needs_live_inventory_tools("сколько компьютеров в парке", "general")
    assert needs_live_inventory_tools("какой шлюз cisco", "network")
    assert not needs_live_inventory_tools("что такое VLAN", "general")


def test_pc_aggregates_for_large_match():
    pcs = [
        _FakePc(hostname=f"PC-{i}", os_name="Windows", os_version="10" if i % 2 == 0 else "11", ram_gb=4 if i < 3 else 16)
        for i in range(12)
    ]
    lines = _pc_aggregates(pcs, term="chrome")
    assert any("ОС:" in ln for ln in lines)
    assert any("RAM:" in ln for ln in lines)


def test_merge_pc_filters_explicit_wins():
    merged = merge_pc_filters("ПК с Windows 10", {"os": "11", "software": "Chrome", "ram_lt": 8})
    assert merged.get("os") == "11"
    assert merged.get("ram_lt") == 8
    assert "chrome" in [t.lower() for t in merged.get("terms") or []]


def test_pc_filters_os_and_ram():
    filters = _extract_pc_filters("ПК с Windows 10 и меньше 8 ГБ ОЗУ")
    assert filters.get("os") == "10"
    assert filters.get("ram_lt") == 8.0
    win10_low = _FakePc(hostname="A", os_name="Windows", os_version="10", ram_gb=4)
    win11 = _FakePc(hostname="B", os_name="Windows", os_version="11", ram_gb=4)
    win10_hi = _FakePc(hostname="C", os_name="Windows", os_version="10", ram_gb=16)
    assert _pc_matches_filters(win10_low, filters)
    assert not _pc_matches_filters(win11, filters)
    assert not _pc_matches_filters(win10_hi, filters)


def test_pc_filters_software_term():
    filters = _extract_pc_filters("у кого установлен Chrome")
    assert "chrome" in filters.get("terms", [])
    has = _FakePc(hostname="X", software=["Google Chrome"])
    miss = _FakePc(hostname="Y", software=["Firefox"])
    assert _pc_matches_filters(has, filters)
    assert not _pc_matches_filters(miss, filters)
