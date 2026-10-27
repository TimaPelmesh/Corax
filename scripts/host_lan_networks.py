#!/usr/bin/env python3
"""Print comma-separated site LAN CIDRs of THIS machine (the Docker host).

Used by scripts/docker_compose_env.js so the app container scans 192.168/10.x
instead of its own 172.x bridge.
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

from app.local_ip import host_lan_cidrs_for_scan  # noqa: E402


def main() -> int:
    cidrs = host_lan_cidrs_for_scan()
    sys.stdout.write(",".join(cidrs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
