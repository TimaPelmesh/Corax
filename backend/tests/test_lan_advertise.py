"""LAN advertise helpers for agent bundles."""
from __future__ import annotations

import ipaddress

from app.local_ip import (
    _is_likely_container_bridge,
    advertise_lan_ipv4,
    list_lan_ipv4,
    pick_primary_lan_ipv4,
)


def test_container_bridge_demoted():
    assert _is_likely_container_bridge(ipaddress.IPv4Address("172.17.0.2"))
    assert _is_likely_container_bridge(ipaddress.IPv4Address("172.18.0.5"))
    assert not _is_likely_container_bridge(ipaddress.IPv4Address("192.168.1.10"))
    assert not _is_likely_container_bridge(ipaddress.IPv4Address("10.0.0.5"))
    # Corporate 172.16.x is NOT treated as docker0
    assert not _is_likely_container_bridge(ipaddress.IPv4Address("172.16.5.1"))


def test_advertise_host_overrides(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "corax_advertise_host", "192.168.50.20")
    assert advertise_lan_ipv4() == "192.168.50.20"
    monkeypatch.setattr(settings, "corax_advertise_host", "http://192.168.50.21:3000/")
    assert advertise_lan_ipv4() == "192.168.50.21"


def test_list_lan_filters_bridges_when_real_lan_exists(monkeypatch):
    from app import local_ip as m

    fake = {
        ipaddress.IPv4Address("192.168.1.5"),
        ipaddress.IPv4Address("172.17.0.2"),
    }
    monkeypatch.setattr(m, "local_ipv4_addresses", lambda: fake)
    out = list_lan_ipv4(include_container_bridges=False)
    assert out == ["192.168.1.5"]
    assert pick_primary_lan_ipv4() == "192.168.1.5"


def test_pick_primary_never_returns_only_docker_bridge(monkeypatch):
    from app import local_ip as m

    fake = {ipaddress.IPv4Address("172.18.0.4")}
    monkeypatch.setattr(m, "local_ipv4_addresses", lambda: fake)
    assert list_lan_ipv4(include_container_bridges=False) == []
    assert pick_primary_lan_ipv4() is None
