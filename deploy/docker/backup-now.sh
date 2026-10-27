#!/usr/bin/env bash
# Optional helper: dump Postgres from the compose stack into ./backups/ on the host.
# Prefer the db-backup sidecar for nightly jobs; use this for ad-hoc dumps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$ROOT/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/backups/corax-${STAMP}.dump"
echo "[backup] writing $OUT"
docker compose -f "$ROOT/docker-compose.yml" exec -T db \
  pg_dump -U "${POSTGRES_USER:-inventory}" -d "${POSTGRES_DB:-inventory}" -Fc \
  > "$OUT"
echo "[backup] done ($(wc -c < "$OUT") bytes)"
