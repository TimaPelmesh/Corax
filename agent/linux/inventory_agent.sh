#!/bin/sh
# CORAX Linux Agent — main entry
# SAFETY: does not read/write server .env or databases. Temp only under /tmp/corax-agent.*.
# shellcheck shell=sh

set -eu

AGENT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LIB="$AGENT_ROOT/lib"
export AGENT_ROOT

# Never inherit a workdir from the environment (could point at install/prod paths).
unset CORAX_WORKDIR 2>/dev/null || true
unset TMPDIR 2>/dev/null || true

if [ -f "$AGENT_ROOT/agent_env.sh" ]; then
  # shellcheck disable=SC1091
  . "$AGENT_ROOT/agent_env.sh"
fi

# shellcheck disable=SC1091
. "$LIB/common.sh"
# shellcheck disable=SC1091
. "$LIB/collect.sh"
# shellcheck disable=SC1091
. "$LIB/post.sh"
# shellcheck disable=SC1091
. "$LIB/emit_min.sh"

load_config_modules() {
  cfg="$AGENT_ROOT/agent_config.json"
  CORAX_PROFILE="${CORAX_PROFILE:-full}"
  for m in patches network domain_sessions bitlocker tpm_secureboot antivirus \
           startup services storage_health battery windows_features office \
           usb_history docker_wsl; do
    eval "CORAX_MOD_${m}=1"
  done
  if [ -f "$cfg" ] && have_cmd python3; then
    # shellcheck disable=SC2046
    eval $(python3 -c '
import json,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
prof=str(p.get("profile") or "full").replace("\"","")
print("CORAX_PROFILE=\"%s\"" % prof)
for k,v in (p.get("modules") or {}).items():
    print("CORAX_MOD_%s=%s" % (k, "1" if v else "0"))
lim=p.get("limits") or {}
if "software_max" in lim: print("CORAX_SOFTWARE_MAX=%d" % int(lim["software_max"]))
if "services_max" in lim: print("CORAX_SERVICES_MAX=%d" % int(lim["services_max"]))
' "$cfg")
  fi
  export CORAX_PROFILE
  export CORAX_SOFTWARE_MAX="${CORAX_SOFTWARE_MAX:-12000}"
  export CORAX_SERVICES_MAX="${CORAX_SERVICES_MAX:-400}"
}

main() {
  log "=== CORAX Linux Agent start ($CORAX_AGENT_VERSION) ==="

  if ! refuse_if_inside_corax_server; then
    exit 2
  fi

  base=${INVENTORY_SERVER:-}
  token=${AGENT_TOKEN:-}
  if ! require_agent_config "$base" "$token"; then
    exit 2
  fi

  load_config_modules

  if ! ensure_workdir; then
    exit 1
  fi
  trap cleanup_workdir EXIT INT TERM

  run_collect_all

  json_out="$CORAX_WORKDIR/report.json"
  if have_cmd python3 && [ -f "$LIB/emit_report.py" ]; then
    log "emit JSON via python3..."
    python3 "$LIB/emit_report.py" "$CORAX_WORKDIR" "$json_out"
  else
    log "python3 not found — minimal JSON emit"
    emit_report_minimal "$json_out"
  fi

  if [ ! -s "$json_out" ]; then
    log "ERROR: empty report"
    exit 1
  fi
  log "report size: $(wc -c <"$json_out") bytes"

  if post_inventory "$json_out" "$base" "$token"; then
    log "=== CORAX Linux Agent OK ==="
    exit 0
  fi
  log "=== CORAX Linux Agent FAILED ==="
  exit 1
}

main "$@"
