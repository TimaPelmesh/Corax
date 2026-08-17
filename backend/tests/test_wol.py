from __future__ import annotations

import pytest

from app.wol import build_magic_packet, format_mac, normalize_mac


def test_normalize_mac_accepts_common_forms():
    assert normalize_mac("AA-BB-CC-DD-EE-FF") == bytes.fromhex("aabbccddeeff")
    assert normalize_mac("aa:bb:cc:dd:ee:ff") == bytes.fromhex("aabbccddeeff")
    assert normalize_mac("aabbccddeeff") == bytes.fromhex("aabbccddeeff")
    assert normalize_mac("AABB.CCDD.EEFF") == bytes.fromhex("aabbccddeeff")


def test_normalize_mac_rejects_invalid():
    with pytest.raises(ValueError):
        normalize_mac(None)
    with pytest.raises(ValueError):
        normalize_mac("")
    with pytest.raises(ValueError):
        normalize_mac("00:11:22:33:44")
    with pytest.raises(ValueError):
        normalize_mac("00:00:00:00:00:00")
    with pytest.raises(ValueError):
        normalize_mac("ff:ff:ff:ff:ff:ff")
    # multicast / I/G bit set
    with pytest.raises(ValueError):
        normalize_mac("01:00:5e:00:00:01")


def test_magic_packet_shape():
    mac = normalize_mac("00:11:22:33:44:55")
    pkt = build_magic_packet(mac)
    assert len(pkt) == 102
    assert pkt[:6] == b"\xff" * 6
    assert pkt[6:] == mac * 16
    assert format_mac(mac) == "00:11:22:33:44:55"
