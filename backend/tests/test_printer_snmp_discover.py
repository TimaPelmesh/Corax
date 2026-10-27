from __future__ import annotations

import ipaddress

from app.network_classify import classify_device
from app.printer_snmp_discover import _expand_hosts, _prioritize_printer_ips


def test_expand_hosts_covers_full_slash24():
    ips, truncated = _expand_hosts([ipaddress.ip_network("10.9.9.0/24")])
    assert not truncated
    assert "10.9.9.1" in ips
    assert "10.9.9.128" in ips
    assert "10.9.9.200" in ips
    assert "10.9.9.254" in ips
    assert len(ips) == 254


def test_prioritize_known_printer_ip():
    ordered = _prioritize_printer_ips(
        ["10.0.0.50", "10.0.0.200", "10.0.0.9"],
        hot={"10.0.0.200"},
    )
    assert ordered[0] == "10.0.0.200"


def test_classify_common_printer_vendors():
    for descr in (
        "HP ETHERNET MULTI-ENVIRONMENT,JETDIRECT",
        "Canon iR-ADV C5550",
        "Brother NC-8300h",
        "KYOCERA Document Solutions Printing System",
        "ZebraNet PrintServer",
    ):
        cls = classify_device(descr)
        assert cls.device_type == "printer", descr
