#!/bin/sh
# CORAX Linux audit sampler.
# Asks the panel whether this host is enrolled, then POSTs one telemetry sample.
# Safe to run every minute: when the panel does not ask, the script exits immediately.
# shellcheck shell=sh

set -eu

AGENT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export AGENT_ROOT
unset CORAX_WORKDIR 2>/dev/null || true
unset TMPDIR 2>/dev/null || true

if [ -f "$AGENT_ROOT/agent_env.sh" ]; then
  # shellcheck disable=SC1091
  . "$AGENT_ROOT/agent_env.sh"
fi

# shellcheck disable=SC1091
. "$AGENT_ROOT/lib/common.sh"
# shellcheck disable=SC1091
. "$AGENT_ROOT/lib/collect_audit.sh"

if have_cmd flock; then
  exec 9>/tmp/corax-audit.lock
  flock -n 9 || exit 0
fi

if ! refuse_if_inside_corax_server; then
  exit 2
fi

base=${INVENTORY_SERVER:-}
token=${AGENT_TOKEN:-}
if ! require_agent_config "$base" "$token"; then
  exit 2
fi

mode=cron
if [ "${1:-}" = "--now" ]; then
  mode=now
fi

hn=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown-host)
hn=$(printf '%s' "$hn" | tr -d '\r\n' | head -c 255)
if have_cmd python3; then
  hn_q=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$hn" 2>/dev/null || printf '%s' "$hn")
else
  hn_q=$hn
fi

base_trim=$(printf '%s' "$base" | sed 's|/*$||')
host_port=$(printf '%s' "$base_trim" | sed 's#^https\{0,1\}://##')
scheme=http
case "$base_trim" in
  https://*) scheme=https ;;
esac
host=$(printf '%s' "$host_port" | cut -d/ -f1 | cut -d: -f1)
port=$(printf '%s' "$host_port" | cut -d/ -f1 | awk -F: '{print $2}')
if [ -z "$port" ]; then
  if [ "$scheme" = https ]; then
    port=443
  else
    port=80
  fi
fi
ports="$port"
for p in 3000 3001 3250; do
  case " $ports " in
    *" $p "*) ;;
    *) ports="$ports $p" ;;
  esac
done

fetch_directive() {
  uri=$1
  body=${CORAX_WORKDIR:-/tmp}/audit_directive.json
  code=000
  if have_cmd curl; then
    code=$(curl -sS -o "$body" -w '%{http_code}' \
      --connect-timeout 8 --max-time 20 \
      -H "Authorization: Bearer $token" \
      "$uri" 2>/dev/null) || true
  elif have_cmd wget; then
    if wget -q -O "$body" --timeout=20 --header="Authorization: Bearer $token" "$uri" 2>/dev/null; then
      code=200
    fi
  fi
  code=$(printf '%s' "$code" | tr -cd '0-9' | awk '{print substr($0,length($0)-2)}')
  printf '%s' "$code"
}

directive_flag() {
  body=$1
  if ! have_cmd python3 || [ ! -s "$body" ]; then
    printf '%s' bad
    return 0
  fi
  python3 -c 'import json,sys
try:
    d=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception:
    print("bad")
    raise SystemExit
if not isinstance(d, dict) or "collect" not in d:
    print("bad")
elif d.get("collect"):
    print("yes")
else:
    print("no")' "$body" 2>/dev/null || printf '%s' bad
}

post_audit() {
  json_file=$1
  code=000
  if have_cmd curl; then
    code=$(curl -sS -o "${CORAX_WORKDIR}/audit_post.txt" -w '%{http_code}' \
      --connect-timeout 8 --max-time 40 \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      --data-binary @"$json_file" \
      "$2" 2>/dev/null) || true
  elif have_cmd wget; then
    if wget -q -O "${CORAX_WORKDIR}/audit_post.txt" --timeout=40 \
      --header="Authorization: Bearer $token" \
      --header="Content-Type: application/json" \
      --post-file="$json_file" \
      "$2" 2>/dev/null; then
      code=200
    fi
  fi
  code=$(printf '%s' "$code" | tr -cd '0-9' | awk '{print substr($0,length($0)-2)}')
  printf '%s' "$code"
}

if ! ensure_workdir; then
  exit 1
fi
trap cleanup_workdir EXIT INT TERM

stamp_file=/var/tmp/corax-last-audit
stamp_age() {
  if [ ! -f "$stamp_file" ]; then
    printf '%s' 999999
    return 0
  fi
  then=$(tr -cd '0-9' <"$stamp_file" | head -c 12)
  now=$(date +%s 2>/dev/null || printf 0)
  case "$then" in
    ''|*[!0-9]*) printf '%s' 999999 ;;
    *) printf '%s' $((now - then)) ;;
  esac
}

asked=0
if [ "$mode" = "now" ]; then
  asked=1
else
  for p in $ports; do
    for path in "/api/v1/agent/audit-directive?hostname=$hn_q" "/api/agent/audit-directive?hostname=$hn_q"; do
      uri="${scheme}://${host}:${p}${path}"
      code=$(fetch_directive "$uri")
      if [ "$code" != "200" ]; then
        continue
      fi
      flag=$(directive_flag "${CORAX_WORKDIR}/audit_directive.json")
      if [ "$flag" = "yes" ]; then
        asked=1
        break 2
      fi
      if [ "$flag" = "no" ]; then
        exit 0
      fi
    done
  done
  if [ "$asked" -ne 1 ]; then
    age=$(stamp_age)
    if [ "$age" -lt 300 ]; then
      log "audit: panel did not answer, last sample ${age}s ago, skip"
      exit 0
    fi
    log "audit: panel did not answer, sending anyway"
    asked=1
  fi
fi

collect_audit_snapshot
json_out="$CORAX_WORKDIR/audit.json"
if [ ! -s "$json_out" ]; then
  log "audit: empty snapshot"
  exit 1
fi

ok=0
for p in $ports; do
  for path in /api/v1/agent/audit /api/agent/audit; do
    uri="${scheme}://${host}:${p}${path}"
    code=$(post_audit "$json_out" "$uri")
    if [ "$code" = "200" ] || [ "$code" = "201" ]; then
      stored=$(python3 -c 'import json,sys
try:
    d=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception:
    print("unknown")
    raise SystemExit
if isinstance(d, dict) and d.get("stored") is True:
    print("yes")
elif isinstance(d, dict):
    print(d.get("reason") or "skip")
else:
    print("unknown")' "${CORAX_WORKDIR}/audit_post.txt" 2>/dev/null || printf '%s' unknown)
      if [ "$stored" = "yes" ] || [ "$stored" = "unknown" ]; then
        date +%s >"$stamp_file" 2>/dev/null || true
        log "audit: stored $hn via $uri"
        printf 'OK %s\n' "$hn"
        ok=1
        break 2
      fi
      log "audit: panel did not store ($stored) via $uri"
      if [ "$stored" = "disabled" ]; then
        exit 0
      fi
      ok=0
      break 2
    fi
    log "audit: HTTP $code $uri"
  done
done

if [ "$ok" -ne 1 ]; then
  exit 1
fi
exit 0
