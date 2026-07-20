#!/usr/bin/env bash
# Optional Linux helper mirroring the admin-panel HTTPS flow.
# Prefer: Settings → HTTPS in CORAX UI. Use this when scripting a headless install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TLS_DIR="${CORAX_TLS_DIR:-$ROOT/backend/data/tls}"
HOSTNAMES="${1:-}"
DAYS="${TLS_DAYS:-825}"

if [[ -z "$HOSTNAMES" ]]; then
  echo "Usage: $0 <ip-or-hostname>[,ip2,...]"
  echo "Example: $0 192.168.1.10,corax.local"
  exit 1
fi

mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR" 2>/dev/null || true

python3 - <<PY
import sys
sys.path.insert(0, r"$ROOT/backend")
from app.tls_certs import generate, set_enabled, status

names = [x.strip() for x in "$HOSTNAMES".replace(";", ",").split(",") if x.strip()]
st = generate(names, days=int("$DAYS"), rotate_ca=False)
print("generated:", st.get("fingerprint_sha256"))
print("ca:", r"$TLS_DIR/ca.crt")
print("Enable in UI or: python -c \"from app.tls_certs import set_enabled; set_enabled(True)\"")
print("Then restart CORAX (run.py / systemd).")
print(status())
PY

echo
echo "Install CA on admin PCs: $TLS_DIR/ca.crt"
echo "Then enable HTTPS in Settings → HTTPS (or set_enabled(True)) and restart."
