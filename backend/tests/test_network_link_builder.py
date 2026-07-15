from __future__ import annotations

from app.network_link_builder import _extract_ips_from_payload, _extract_macs_from_payload


def test_extract_macs_from_payload_json():
    raw = '{"extended":{"network":{"adapters":[{"mac":"AA-BB-CC-11-22-33"}]}}}'
    macs = _extract_macs_from_payload(raw)
    assert "aa:bb:cc:11:22:33" in macs


def test_extract_macs_from_plain_text():
    macs = _extract_macs_from_payload("NIC 00:1A:2B:3C:4D:5E active")
    assert "00:1a:2b:3c:4d:5e" in macs


def test_extract_ips_skips_loopback():
    ips = _extract_ips_from_payload("gw 10.0.0.1 loop 127.0.0.1 host 192.168.1.50")
    assert "10.0.0.1" in ips
    assert "192.168.1.50" in ips
    assert "127.0.0.1" not in ips
