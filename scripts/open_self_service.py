"""Open the CORAX LAN request form for this Windows workstation."""
from __future__ import annotations

import os
import sys
import urllib.parse
import webbrowser


def main() -> None:
    base_url = (os.environ.get("CORAX_URL") or "http://localhost:3000").rstrip("/")
    hostname = (os.environ.get("COMPUTERNAME") or "").strip()
    if not hostname:
        raise SystemExit("COMPUTERNAME is not available")
    webbrowser.open(f"{base_url}/r#pc={urllib.parse.quote(hostname)}")


if __name__ == "__main__":
    main()
