from __future__ import annotations

from app.local_ip import list_lan_ipv4, pick_primary_lan_ipv4
from app.oem_normalize import normalize_manufacturer, normalize_system_model


def test_normalize_manufacturer():
    assert normalize_manufacturer("Dell Inc.") == "Dell"
    assert normalize_manufacturer(None) is None


def test_normalize_system_model():
    assert normalize_system_model("OptiPlex 7090") == "OptiPlex 7090"


def test_lan_ip_helpers():
    ips = list_lan_ipv4()
    assert isinstance(ips, list)
    primary = pick_primary_lan_ipv4()
    assert primary is None or isinstance(primary, str)
