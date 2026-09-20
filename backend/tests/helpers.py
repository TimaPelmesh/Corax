from __future__ import annotations

import uuid


def unique_hostname(prefix: str = "pytest-pc") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


def sample_inventory(hostname: str | None = None) -> dict:
    hn = hostname or unique_hostname()
    return {
        "hostname": hn,
        "serial_number": "SN-TEST-001",
        "mac_primary": "00:11:22:33:44:55",
        "cpu": "Intel Core i5-12400",
        "ram_gb": 16.0,
        "os_name": "Windows 10 Pro",
        "os_version": "10.0.19045",
        "manufacturer": "Dell Inc.",
        "model": "OptiPlex 7090",
        "location": "Кабинет 101",
        "gpu_name": "Intel UHD Graphics 730",
        "memory_used_percent": 42,
        "disks": [
            {"mount": "C:", "label": "System", "total_gb": 238.5, "used_percent": 55, "free_gb": 107.0},
        ],
        "software": [
            {"name": "Microsoft Office", "version": "16.0"},
            {"name": "Google Chrome", "version": "120.0"},
        ],
        "peripherals": [
            {"kind": "keyboard", "name": "USB Keyboard"},
            {"kind": "mouse", "name": "USB Mouse"},
        ],
        "extended": {
            "physical_disks": [{"media_type": "SSD", "size_gb": 238.5}],
        },
    }
