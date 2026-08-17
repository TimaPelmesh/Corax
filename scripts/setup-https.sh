#!/usr/bin/env bash
# Generate local CA + server cert and enable HTTPS (Linux / headless).
# Prefer UI: Settings → HTTPS. This script is for servers without a browser session.
#
# Usage:
#   ./scripts/setup-https.sh 192.168.1.10
#   ./scripts/setup-https.sh 192.168.1.10,corax.local
#   TLS_DAYS=365 ./scripts/setup-https.sh 10.0.0.5
#
# Then: sudo systemctl restart corax-backend
# Clients: copy backend/data/tls/ca.crt → install-corax-ca.sh / Windows install-corax-ca.bat
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TLS_DIR="${CORAX_TLS_DIR:-$ROOT/backend/data/tls}"
HOSTNAMES="${1:-}"
DAYS="${TLS_DAYS:-825}"
ENABLE="${TLS_ENABLE:-1}"

if [[ -z "$HOSTNAMES" ]]; then
  echo "Usage: $0 <ip-or-hostname>[,ip2,...]"
  echo "Example: $0 192.168.1.10,corax.local"
  exit 1
fi

mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR" 2>/dev/null || true

export PYTHONPATH="${ROOT}/backend${PYTHONPATH:+:$PYTHONPATH}"
python3 - <<PY
import sys
sys.path.insert(0, r"$ROOT/backend")
from app.tls_certs import generate, set_enabled, status

names = [x.strip() for x in "$HOSTNAMES".replace(";", ",").split(",") if x.strip()]
st = generate(names, days=int("$DAYS"), rotate_ca=False)
print("generated:", st.get("fingerprint_sha256"))
print("ca:", r"$TLS_DIR/ca.crt")
if "$ENABLE" in ("1", "true", "yes"):
    set_enabled(True)
    print("enabled: True")
print(status())
PY

chmod 600 "$TLS_DIR"/ca.key "$TLS_DIR"/server.key 2>/dev/null || true
chmod 644 "$TLS_DIR"/ca.crt "$TLS_DIR"/server.crt 2>/dev/null || true

echo
echo "Next:"
echo "  1) sudo systemctl restart corax-backend   # or: ENVIRONMENT=production RELOAD=0 PORT=3000 python3 run.py"
echo "  2) On admin PCs install CA:  $TLS_DIR/ca.crt"
echo "     Linux:  sudo ./scripts/install-corax-ca.sh"
echo "     Windows: scripts\\\\install-corax-ca.bat"
echo "  3) Open https://<ip>:3000"
