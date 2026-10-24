#!/bin/sh
# CORAX Linux audit sampler.
# Cron (no args) asks the panel, then sends when the button is set, when the
# host interval has elapsed on this machine, or when the panel is silent.
# --now always sends one sample. A reply without "stored": true is not success.
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

if ! refuse_if_inside_corax_server; then
  exit 2
fi

# The minute poll plants the 04:00 job, so hosts pick it up after this script lands.
ensure_nightly_script_update || true

if have_cmd flock; then
  exec 9>/tmp/corax-audit.lock
  flock -n 9 || exit 0
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
    raise SystemExit
try:
    iv=int(d.get("interval_minutes") or 0)
except (TypeError, ValueError):
    iv=0
if iv < 0:
    iv=0
if iv > 10080:
    iv=10080
reason=str(d.get("reason") or "idle")
if reason not in {"enroll", "disabled", "requested", "interval", "idle"}:
    reason="idle"
print(("yes" if d.get("collect") else "no") + " " + str(iv) + " " + reason)' "$body" 2>/dev/null || printf '%s' bad
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
stamp_field() {
  n=$1
  if [ ! -f "$stamp_file" ]; then
    printf '%s' ''
    return 0
  fi
  awk -v n="$n" 'NR==1 { print $n }' "$stamp_file" 2>/dev/null | tr -cd '0-9' | head -c 12
}

stamp_age() {
  then=$(stamp_field 1)
  now=$(date +%s 2>/dev/null || printf '%s' 0)
  case "$then" in
    ''|*[!0-9]*) printf '%s' 999999; return 0 ;;
  esac
  case "$now" in
    ''|*[!0-9]*) printf '%s' 999999; return 0 ;;
  esac
  if [ "$now" -lt "$then" ]; then
    printf '%s' 999999
    return 0
  fi
  printf '%s' $((now - then))
}

stamp_interval() {
  stamp_field 2
}

write_stamp() {
  printf '%s %s\n' "$(date +%s 2>/dev/null || printf '%s' 0)" "${1:-5}" >"$stamp_file" 2>/dev/null || true
}

apply_directive() {
  parsed=$1
  flag=${parsed%% *}
  rest=${parsed#* }
  iv=${rest%% *}
  case "$rest" in
    *" "*) reason=${rest#* } ;;
    *) reason=idle ;;
  esac
}

asked=0
flag=bad
iv=5
reason=
fallback_no=
if [ "$mode" = "now" ]; then
  asked=1
else
  # The port from agent_env.sh is authoritative. Another port may only
  # say "collect" — a stranger that answers {"collect": false} must not
  # cancel the real panel.
  for p in $ports; do
    for path in "/api/v1/agent/audit-directive?hostname=$hn_q" "/api/agent/audit-directive?hostname=$hn_q"; do
      uri="${scheme}://${host}:${p}${path}"
      code=$(fetch_directive "$uri")
      if [ "$code" != "200" ]; then
        continue
      fi
      parsed=$(directive_flag "${CORAX_WORKDIR}/audit_directive.json")
      case "$parsed" in
        yes\ *)
          apply_directive "$parsed"
          break 2
          ;;
        no\ *)
          if [ "$p" = "$port" ]; then
            apply_directive "$parsed"
            break 2
          fi
          fallback_no=$parsed
          ;;
      esac
    done
  done
  if [ "$flag" = "bad" ] && [ -n "$fallback_no" ]; then
    apply_directive "$fallback_no"
  fi
  case "$iv" in
    ''|*[!0-9]*) iv=5 ;;
  esac
  if [ "${reason:-}" = "disabled" ]; then
    log "audit: host disabled"
    exit 0
  fi
  age=$(stamp_age)
  if [ "$flag" = "yes" ]; then
    log "audit: panel asked, sending"
    asked=1
  elif [ "$flag" = "no" ]; then
    if [ "$iv" -le 0 ]; then
      log "audit: manual, waiting for the button"
      exit 0
    fi
    need=$((iv * 60))
    if [ "$age" -ge "$need" ]; then
      log "audit: ${iv}m elapsed (${age}s), sending"
      asked=1
    else
      log "audit: idle, next in $((need - age))s"
      exit 0
    fi
  else
    saved=$(stamp_interval)
    case "$saved" in
      '') need=300 ;;
      0)
        log "audit: panel silent, manual mode, skip"
        exit 0
        ;;
      *) need=$((saved * 60)) ;;
    esac
    if [ "$age" -ge "$need" ]; then
      log "audit: panel silent for ${age}s, sending"
      asked=1
    else
      log "audit: panel silent, last sample ${age}s ago, skip"
      exit 0
    fi
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
      if [ "$stored" = "yes" ]; then
        keep_iv=$iv
        if [ "$mode" = "now" ]; then
          saved=$(stamp_interval)
          case "$saved" in
            ''|*[!0-9]*) ;;
            *) keep_iv=$saved ;;
          esac
        fi
        write_stamp "$keep_iv"
        log "audit: stored $hn via $uri"
        printf 'OK %s\n' "$hn"
        ok=1
        break 2
      fi
      if [ "$stored" = "unknown" ]; then
        log "audit: HTTP $code is not a CORAX reply, trying next ($uri)"
        continue
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
