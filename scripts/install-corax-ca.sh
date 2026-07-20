#!/usr/bin/env bash
# Install CORAX Local CA into the system trust store (admin client PCs).
# Usage:
#   sudo ./scripts/install-corax-ca.sh
#   sudo ./scripts/install-corax-ca.sh /path/to/corax-local-ca.crt
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CA="${1:-$ROOT/backend/data/tls/ca.crt}"

if [[ ! -f "$CA" ]]; then
  echo "CA not found: $CA"
  echo "Create in CORAX UI (Settings → HTTPS → Download CA) or:"
  echo "  ./scripts/setup-https.sh 192.168.1.10"
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0 $CA"
  exit 1
fi

echo "[ca] Installing $CA"

if command -v update-ca-certificates >/dev/null 2>&1; then
  # Debian / Ubuntu
  install -m 0644 "$CA" /usr/local/share/ca-certificates/corax-local-ca.crt
  update-ca-certificates
elif command -v update-ca-trust >/dev/null 2>&1; then
  # RHEL / Fedora / CentOS
  install -m 0644 "$CA" /etc/pki/ca-trust/source/anchors/corax-local-ca.crt
  update-ca-trust extract
elif command -v trust >/dev/null 2>&1; then
  trust anchor "$CA"
else
  echo "No known CA update tool (update-ca-certificates / update-ca-trust)."
  exit 1
fi

echo "[ok] CA trusted system-wide."
echo "Firefox still needs manual import (its own store)."
echo "Restart browsers, open https://SERVER:3000"
