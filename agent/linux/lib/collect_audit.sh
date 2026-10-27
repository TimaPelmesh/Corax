#!/bin/sh
# CORAX Agent — write $CORAX_WORKDIR/audit.json (live server metrics).
# shellcheck shell=sh

collect_audit_snapshot() {
  py="${AGENT_ROOT:-}/lib/collect_audit.py"
  if [ ! -f "$py" ]; then
    log "audit: collect_audit.py missing, skip"
    return 0
  fi
  if ! have_cmd python3; then
    log "audit: python3 missing, skip telemetry"
    return 0
  fi
  if [ -z "${CORAX_WORKDIR:-}" ]; then
    log "audit: no workdir, skip"
    return 0
  fi
  if python3 "$py" "$CORAX_WORKDIR/audit.json"; then
    log "audit: snapshot $(wc -c <"$CORAX_WORKDIR/audit.json" 2>/dev/null || echo 0) bytes"
    return 0
  fi
  log "audit: collector failed"
  return 0
}
