from __future__ import annotations

import pytest

from app.wol import (
    build_magic_packet,
    format_mac,
    iface_is_virtual,
    interfaces_from_ipconfig,
    normalize_mac,
    send_wake,
)


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


def test_ipconfig_skips_virtual_adapters():
    text = """
Ethernet adapter Ethernet:

   IPv4 Address. . . . . . . . . . . : 192.168.1.20
   Subnet Mask . . . . . . . . . . . : 255.255.255.0

Ethernet adapter vEthernet (WSL):

   IPv4 Address. . . . . . . . . . . : 172.22.96.1
   Subnet Mask . . . . . . . . . . . : 255.255.240.0

Неизвестный адаптер Ethernet:

   IPv4-адрес. . . . . . . . . . . . : 10.1.2.3
   Маска подсети . . . . . . . . . . : 255.255.255.0
"""
    found = {ip: str(net) for _alias, ip, net in interfaces_from_ipconfig(text)}
    assert found["192.168.1.20"] == "192.168.1.0/24"
    assert found["10.1.2.3"] == "10.1.2.0/24"
    assert "172.22.96.1" not in found
    assert iface_is_virtual("vEthernet (WSL)")
    assert iface_is_virtual("docker0") is True


def test_docker_without_relay_does_not_pretend_success(monkeypatch):
    monkeypatch.setenv("CORAX_DOCKER", "1")
    monkeypatch.delenv("CORAX_WOL_QUEUE_DIR", raising=False)
    result = send_wake(normalize_mac("00:11:22:33:44:55"))
    assert result["sent"] == 0
    assert result["detail"] == "docker_no_relay"


def test_queue_hands_packet_to_host(monkeypatch, tmp_path):
    import json
    import threading
    import time
    from pathlib import Path

    token = "relay-token-for-unit-test"
    monkeypatch.setenv("CORAX_WOL_QUEUE_DIR", str(tmp_path))
    monkeypatch.setenv("CORAX_WOL_RELAY_TOKEN", token)
    monkeypatch.setenv("CORAX_DOCKER", "1")

    def relay() -> None:
        deadline = time.time() + 2
        while time.time() < deadline:
            for req in Path(tmp_path).glob("req-*.json"):
                data = json.loads(req.read_text(encoding="utf-8"))
                assert data["token"] == token
                assert data["mac"] == "00:11:22:33:44:55"
                assert data["ip"] == "192.168.1.50"
                uid = req.name[len("req-") : -len(".json")]
                (Path(tmp_path) / f"res-{uid}.json").write_text(
                    '{"sent": 4, "errors": 0, "detail": ""}',
                    encoding="utf-8",
                )
                return
            time.sleep(0.02)

    threading.Thread(target=relay, daemon=True).start()
    result = send_wake(normalize_mac("00:11:22:33:44:55"), target_ip="192.168.1.50")
    assert result["sent"] == 4
    assert result["errors"] == 0


def test_magic_packet_shape():
    mac = normalize_mac("00:11:22:33:44:55")
    pkt = build_magic_packet(mac)
    assert len(pkt) == 102
    assert pkt[:6] == b"\xff" * 6
    assert pkt[6:] == mac * 16
    assert format_mac(mac) == "00:11:22:33:44:55"
