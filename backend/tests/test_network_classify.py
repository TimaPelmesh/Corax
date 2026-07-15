from __future__ import annotations

from app.network_classify import (
    ClassifyHints,
    build_hints_from_interfaces,
    classify_device,
    infer_network_role,
    normalize_mac,
    network_dedupe_key_for_ip,
)


def test_classify_switch():
    c = classify_device("HP J9776A 2530-48G Switch, revision YA.16.11")
    assert c.is_network_gear
    assert c.device_type == "switch"
    assert c.vendor == "HPE/Aruba"
    assert c.confidence >= 0.4


def test_classify_cisco_router():
    c = classify_device("Cisco IOS Software, ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M)")
    assert c.is_network_gear
    assert c.device_type == "router"
    assert c.vendor == "Cisco"


def test_classify_mikrotik():
    c = classify_device("RouterOS CCR1009", sys_object_id="1.3.6.1.4.1.14988.1")
    assert c.is_network_gear
    assert c.vendor == "MikroTik"
    assert c.device_type == "router"


def test_classify_ap():
    c = classify_device("Ubiquiti UniFi AP-AC-Pro")
    assert c.is_network_gear
    assert c.device_type == "ap"
    assert c.vendor == "Ubiquiti"


def test_reject_printer():
    c = classify_device("HP LaserJet Pro MFP M428fdn")
    assert not c.is_network_gear
    assert c.device_type == "printer"


def test_accept_generic_snmp_appliance():
    c = classify_device("Embedded SNMP Agent v2.1 build 104")
    assert c.is_network_gear
    assert c.device_type == "unknown"


def test_reject_windows_workstation():
    c = classify_device("Hardware: Intel64 Family 6 Model — Software: Windows 10 Version 1909")
    assert not c.is_network_gear
    assert c.device_type == "host"


def test_classify_by_bridge_hints():
    hints = ClassifyHints(ethernet_ports=48, has_bridge_fdb=True, fdb_entries=120, ip_forwarding=False)
    c = classify_device("SNMP Agent", sys_object_id="1.3.6.1.4.1.11.2.3.7.11", hints=hints)
    assert c.is_network_gear
    assert c.device_type == "switch"
    assert c.vendor == "HPE/Aruba"


def test_classify_l3_switch_prefers_switch():
    hints = ClassifyHints(ethernet_ports=24, has_bridge_fdb=True, fdb_entries=80, ip_forwarding=True)
    c = classify_device("Cisco IOS Software, C2960 Software", sys_name="sw-floor-1", hints=hints)
    assert c.device_type == "switch"
    assert c.vendor == "Cisco"


def test_classify_hostname_ap():
    c = classify_device("Linux AP", sys_name="ap-lobby-01")
    assert c.device_type == "ap"


def test_classify_nas():
    c = classify_device("Linux DiskStation synology_denverton DS920+")
    assert c.is_network_gear
    assert c.device_type == "nas"
    assert c.vendor == "Synology"


def test_classify_ups():
    c = classify_device("APC Web/SNMP Management Card (MB:v4.1.0 PF:v6.5.6)")
    assert c.device_type == "ups"
    assert c.vendor == "APC"


def test_classify_camera():
    c = classify_device("Hikvision-DS-2CD2143G0-I")
    assert c.device_type == "camera"


def test_classify_server_esxi():
    c = classify_device("VMware ESXi 7.0.3 build-19193900")
    assert c.device_type == "server"
    assert c.is_network_gear


def test_classify_voip():
    c = classify_device("Yealink SIP-T46U 66.86.0.15")
    assert c.device_type == "voip"


def test_build_hints_counts_iftypes():
    class I:
        def __init__(self, t, oper="up"):
            self.if_type = t
            self.oper_status = oper
            self.name = "Gi0/1"

    hints = build_hints_from_interfaces([I(6), I(6), I(71)], fdb_count=10)
    assert hints.ethernet_ports == 2
    assert hints.wifi_ports == 1
    assert hints.has_bridge_fdb


def test_normalize_mac():
    assert normalize_mac("AA-BB-CC-DD-EE-FF") == "aa:bb:cc:dd:ee:ff"
    assert normalize_mac("aabbccddeeff") == "aa:bb:cc:dd:ee:ff"
    assert normalize_mac(bytes([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF])) == "aa:bb:cc:dd:ee:ff"
    assert normalize_mac(None) is None


def test_dedupe_key():
    assert network_dedupe_key_for_ip("10.0.0.1") == "snmp:10.0.0.1"


def test_infer_role_gateway_dns_infra():
    assert infer_network_role(hostname="Gateway · 192.168.3.250", device_type="router") == "gateway"
    assert infer_network_role(hostname="DNS · 192.168.3.6", device_type="server") == "dns"
    assert infer_network_role(hostname="Infra · 192.168.3.1", device_type="unknown", source="arp-seed") == "infra"
    assert infer_network_role(hostname="core-sw-01", device_type="switch") == "switch"
