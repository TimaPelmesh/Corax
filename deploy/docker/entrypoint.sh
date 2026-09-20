#!/usr/bin/env bash
# CORAX container entrypoint.
# Industry pattern: wait for dependencies → start app (migrations run in app lifespan).
set -euo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
RELOAD="${RELOAD:-0}"
export HOST PORT RELOAD
export CORAX_DOCKER=1
export SKIP_ENSURE_POSTGRES="${SKIP_ENSURE_POSTGRES:-1}"

mkdir -p \
  "${AGENT_INBOX_DIR:-/data/agent_inbox}" \
  "${WIKI_RAG_DIR:-/data/wiki_rag_docs}" \
  "${TLS_DIR:-/data/tls}" \
  /data/backups 2>/dev/null || true

wait_for_postgres() {
  local url="${DATABASE_URL:-}"
  if [[ -z "$url" ]]; then
    echo "[entrypoint] DATABASE_URL not set — skipping DB wait"
    return 0
  fi
  # postgresql+asyncpg://user:pass@host:5432/db → host/user/db for pg_isready
  local bare="${url#*://}"
  local creds="${bare%%@*}"
  local hostpart="${bare#*@}"
  local user="${creds%%:*}"
  local hostport="${hostpart%%/*}"
  local host="${hostport%%:*}"
  local port="${hostport##*:}"
  local db="${hostpart#*/}"
  db="${db%%\?*}"
  if [[ "$host" == "$port" ]]; then
    port=5432
  fi
  echo "[entrypoint] waiting for Postgres ${host}:${port} db=${db} ..."
  local i=0
  until pg_isready -h "$host" -p "$port" -U "$user" -d "$db" >/dev/null 2>&1; do
    i=$((i + 1))
    if [[ "$i" -ge 60 ]]; then
      echo "[entrypoint] Postgres not ready after 60s" >&2
      exit 1
    fi
    sleep 1
  done
  echo "[entrypoint] Postgres is ready"
}

wait_for_postgres

echo "[entrypoint] starting CORAX on ${HOST}:${PORT} (RELOAD=${RELOAD})"
exec "$@"
