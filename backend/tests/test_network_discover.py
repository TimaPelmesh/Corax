from __future__ import annotations

import ipaddress

from app.local_ip import discover_corax_network_scope
from app.network_snmp import NetworkSnmpSnapshot
from app.network_snmp_discover import (
    _accept_discovered,
    _merge_communities,
    _prioritize_hosts,
    _private_networks_from_cidrs,
    resolve_discovery_networks,
)


def test_expand_cidr_to_slash24():
    nets = _private_networks_from_cidrs(["10.0.0.0/22"])
    assert len(nets) == 4
    assert all(n.prefixlen == 24 for n in nets)


def test_accept_vague_snmp_gateway():
    snap = NetworkSnmpSnapshot(sys_descr="Linux OpenWrt", device_type="unknown", is_network_gear=False)
    assert _accept_discovered(snap)


def test_reject_printer():
    snap = NetworkSnmpSnapshot(sys_descr="HP LaserJet", device_type="printer", is_network_gear=False)
    assert not _accept_discovered(snap)


def test_merge_communities_only_configured():
    merged = _merge_communities("MyComm", ["extra", "public"])
    assert merged == ["MyComm", "extra", "public"]
    # No hardcoded extras beyond what was passed
    assert _merge_communities("only", None) == ["only"]


def test_prioritize_hot_seeds():
    hosts = [ipaddress.IPv4Address(f"192.168.1.{i}") for i in (50, 1, 100, 254)]
    ordered = _prioritize_hosts(hosts, hot={"192.168.1.100"})
    assert str(ordered[0]) == "192.168.1.100"
    assert str(ordered[1]) == "192.168.1.1"


def test_corax_scope_includes_server_home():
    scope = discover_corax_network_scope(max_subnets=48)
    assert scope.reasons
    # Scope must stay private and bounded
    assert len(scope.networks) <= 48
    for n in scope.networks:
        assert n.is_private
        assert n.prefixlen >= 24


def test_manual_cidr_overrides_auto():
    nets, reasons = resolve_discovery_networks(["10.9.0.0/24"])
    assert len(nets) == 1
    assert str(nets[0]) == "10.9.0.0/24"
    assert any("ручной" in r for r in reasons)
