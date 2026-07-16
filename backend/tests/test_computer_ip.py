from __future__ import annotations

from app.computer_ip import (
    primary_ipv4_from_extended,
    primary_ipv4_from_raw_payload,
    resolve_computer_ipv4,
)


def test_primary_ipv4_prefers_adapter_with_gateway():
    ext = {
        "network": {
            "adapters": [
                {"ipv4": ["192.168.1.50"], "gateway": None},
                {"ipv4": ["10.0.0.15"], "gateway": "10.0.0.1"},
            ]
        }
    }
    assert primary_ipv4_from_extended(ext) == "10.0.0.15"


def test_primary_ipv4_skips_link_local_and_prefers_private():
    ext = {
        "network": {
            "adapters": [
                {"ipv4": ["169.254.1.2", "8.8.8.8", "192.168.10.4"], "gateway": "192.168.10.1"},
            ]
        }
    }
    assert primary_ipv4_from_extended(ext) == "192.168.10.4"


def test_primary_from_raw_payload():
    raw = '{"hostname":"x","extended":{"network":{"adapters":[{"ipv4":["172.16.0.9"],"gateway":"172.16.0.1"}]}}}'
    assert primary_ipv4_from_raw_payload(raw) == "172.16.0.9"


def test_primary_ipv4_accepts_string_ipv4():
    ext = {
        "network": {
            "adapters": [
                {"ipv4": "10.1.2.3", "gateway": "10.1.2.1", "status": "Up"},
            ]
        }
    }
    assert primary_ipv4_from_extended(ext) == "10.1.2.3"


def test_prefer_mac_adapter():
    ext = {
        "network": {
            "adapters": [
                {
                    "mac_address": "AA-BB-CC-DD-EE-01",
                    "ipv4": ["10.0.0.1"],
                    "gateway": "10.0.0.254",
                },
                {
                    "mac_address": "AA:BB:CC:DD:EE:FF",
                    "ipv4": ["10.0.0.99"],
                    "gateway": None,
                },
            ]
        }
    }
    assert primary_ipv4_from_extended(ext, prefer_mac="aa:bb:cc:dd:ee:ff") == "10.0.0.99"


def test_resolve_uses_stored_ip_first():
    assert (
        resolve_computer_ipv4(
            ip_address="10.9.8.7",
            hostname="no-such-host-zzz",
            mac_primary=None,
            raw_payload=None,
        )
        == "10.9.8.7"
    )
