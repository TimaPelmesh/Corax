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
    assert _is_likely_container_bridge(ipaddress.IPv4Address("192.168.65.254"))
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


def _docker_only_scope():
    from app.local_ip import CoraxNetworkScope

    return CoraxNetworkScope(
        networks=(ipaddress.ip_network("172.18.0.0/24"),),
        reasons=("сервер CORAX в Docker: 172.18.0.2",),
        server_ips=("172.18.0.2",),
        gateways=(),
        arp_hosts=0,
        routed_nets=0,
    )


def test_scan_skips_docker_uses_inventory_hint(monkeypatch):
    from app import local_ip as m
    from app.local_ip import resolve_lan_scan_networks

    monkeypatch.setattr(m, "discover_corax_network_scope", lambda max_subnets=64: _docker_only_scope())
    monkeypatch.setattr(m, "_env_scan_cidrs", lambda: [])
    nets, reasons = resolve_lan_scan_networks(hint_ips=["192.168.40.12", "172.18.0.2"])
    assert [str(n) for n in nets] == ["192.168.40.0/24"]
    assert any("инвентарь" in r for r in reasons)
    assert all(not str(n).startswith("172.18") for n in nets)


def test_scan_uses_host_lan_env_when_container_has_no_lan(monkeypatch):
    from app import local_ip as m
    from app.local_ip import resolve_lan_scan_networks

    monkeypatch.setattr(m, "discover_corax_network_scope", lambda max_subnets=64: _docker_only_scope())
    monkeypatch.setattr(m, "_env_scan_cidrs", lambda: ["192.168.88.10"])
    nets, reasons = resolve_lan_scan_networks()
    assert [str(n) for n in nets] == ["192.168.88.0/24"]
    assert any("LAN хоста" in r for r in reasons)


def test_host_lan_cidrs_filters_docker(monkeypatch):
    from app import local_ip as m
    from app.local_ip import host_lan_cidrs_for_scan

    fake = {
        ipaddress.IPv4Address("192.168.3.10"),
        ipaddress.IPv4Address("172.18.0.4"),
    }
    monkeypatch.setattr(m, "local_ipv4_addresses", lambda: fake)
    monkeypatch.setattr(
        m,
        "local_ipv4_networks",
        lambda: [
            ipaddress.ip_network("192.168.3.0/24"),
            ipaddress.ip_network("172.18.0.0/16"),
        ],
    )
    cidrs = host_lan_cidrs_for_scan()
    assert "192.168.3.0/24" in cidrs
    assert not any(c.startswith("172.18") for c in cidrs)
