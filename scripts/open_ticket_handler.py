#!/usr/bin/env python3
"""Open CORAX ticket-handler client form for this PC (beta shortcut helper)."""

from __future__ import annotations

import os
import sys
import webbrowser
from urllib.parse import quote


def main() -> int:
    base = (os.environ.get("CORAX_URL") or "http://localhost:3000").rstrip("/")
    hostname = (os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "").strip()
    if len(sys.argv) > 1 and sys.argv[1].strip():
        base = sys.argv[1].rstrip("/")
    if len(sys.argv) > 2 and sys.argv[2].strip():
        hostname = sys.argv[2].strip()
    if not hostname:
        print("Set COMPUTERNAME or pass: open_ticket_handler.py http://CORAX:3000 PC-NAME", file=sys.stderr)
        return 2
    url = f"{base}/h#pc={quote(hostname)}"
    print(url)
    webbrowser.open(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
