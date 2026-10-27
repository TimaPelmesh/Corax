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

if [ "${CORAX_AUDIT_INSIDE_LOOP:-}" != "1" ] && have_cmd flock; then
  # Same reason as update_scripts.sh: do not lock in sticky /tmp.
  lock="$AGENT_ROOT/.corax-audit.lock"
  if [ ! -e "$lock" ]; then
    (umask 000; : >"$lock") 2>/dev/null || true
  fi
  chmod 666 "$lock" 2>/dev/null || true
  if exec 9>"$lock"; then
    flock -n 9 || exit 0
  fi
fi

base=${INVENTORY_SERVER:-}
token=${AGENT_TOKEN:-}
if ! require_agent_config "$base" "$token"; then
  exit 2
fi

mode=cron
case "${1:-}" in
  --now) mode=now ;;
  --loop) mode=loop ;;
  --tick) mode=tick ;;
esac

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
raw_sec=d.get("interval_seconds")
try:
    sec=int(raw_sec) if raw_sec is not None else iv * 60
except (TypeError, ValueError):
    sec=iv * 60
if iv < 0:
    iv=0
if iv > 10080:
    iv=10080
if sec < 0:
    sec=0
if sec > 604800:
    sec=604800
reason=str(d.get("reason") or "idle")
if reason not in {"enroll", "disabled", "requested", "interval", "idle"}:
    reason="idle"
print(("yes" if d.get("collect") else "no") + " " + str(iv) + " " + str(sec) + " " + reason)' "$body" 2>/dev/null || printf '%s' bad
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

# /var/tmp is sticky like /tmp, so a stamp owned by another user cannot be
# replaced, even by root. Keep it next to the scripts and share it (mode 666).
stamp_file="$AGENT_ROOT/.corax-last-audit"
if [ ! -f "$stamp_file" ] && [ -r /var/tmp/corax-last-audit ]; then
  cp /var/tmp/corax-last-audit "$stamp_file" 2>/dev/null || true
fi
chmod 666 "$stamp_file" 2>/dev/null || true
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

stamp_seconds() {
  if [ ! -f "$stamp_file" ]; then
    printf '%s' ''
    return 0
  fi
  awk 'NR==1 {
    if ($3 == "s" && $2 ~ /^[0-9]+$/) print $2
    else if ($2 ~ /^[0-9]+$/) print $2 * 60
  }' "$stamp_file" 2>/dev/null | head -c 12
}

write_stamp() {
  printf '%s %s s\n' "$(date +%s 2>/dev/null || printf '%s' 0)" "${1:-300}" >"$stamp_file" 2>/dev/null || true
  chmod 666 "$stamp_file" 2>/dev/null || true
}

# pace: sleep until the last sample is interval seconds old.
# poll: ask again after N seconds (manual mode and a disabled host).
publish_interval() {
  kind=$1
  sec=$2
  case "$sec" in
    ''|*[!0-9]*) return 0 ;;
  esac
  case "$kind" in
    pace|poll) ;;
    *) kind=pace ;;
  esac
  printf '%s %s\n' "$kind" "$sec" >"$AGENT_ROOT/.corax-audit-interval" 2>/dev/null || true
  chmod 666 "$AGENT_ROOT/.corax-audit-interval" 2>/dev/null || true
}

apply_directive() {
  parsed=$1
  flag=${parsed%% *}
  rest=${parsed#* }
  iv=${rest%% *}
  case "$rest" in
    *" "*) rest=${rest#* } ;;
    *) rest=idle ;;
  esac
  iv_sec=${rest%% *}
  case "$rest" in
    *" "*) reason=${rest#* } ;;
    *) reason=$rest ;;
  esac
  case "$iv_sec" in
    ''|*[!0-9]*)
      case "$iv" in
        ''|*[!0-9]*) iv_sec=300 ;;
        *) iv_sec=$((iv * 60)) ;;
      esac
      ;;
  esac
  if [ "$reason" = "enroll" ]; then
    # Unknown-host default is 300s, and the bundle clock is often 60s.
    # A sample already stored on the real host must keep that host's seconds.
    if [ -f "$AGENT_ROOT/.corax-audit-interval" ]; then
      kept_kind=$(awk 'NR==1 { print $1 }' "$AGENT_ROOT/.corax-audit-interval" 2>/dev/null || true)
      kept=$(awk 'NR==1 { print $2 }' "$AGENT_ROOT/.corax-audit-interval" 2>/dev/null || true)
      case "$kept" in
        ''|*[!0-9]*) ;;
        *)
          if [ "$kept_kind" = "poll" ]; then
            iv_sec=0
          else
            iv_sec=$kept
          fi
          return 0
          ;;
      esac
    fi
    case "${CORAX_AUDIT_INTERVAL:-}" in
      ''|*[!0-9]*) ;;
      *) iv_sec=$CORAX_AUDIT_INTERVAL ;;
    esac
  fi
  if [ "$iv_sec" -eq 0 ]; then
    publish_interval poll 15
  else
    publish_interval pace "$iv_sec"
  fi
}

send_sample() {
  collect_audit_snapshot
  json_out="$CORAX_WORKDIR/audit.json"
  if [ ! -s "$json_out" ]; then
    log "audit: empty snapshot"
    return 1
  fi
  for p in $ports; do
    for path in /api/v1/agent/audit /api/agent/audit; do
      uri="${scheme}://${host}:${p}${path}"
      code=$(post_audit "$json_out" "$uri")
      if [ "$code" != "200" ] && [ "$code" != "201" ]; then
        log "audit: HTTP $code $uri"
        continue
      fi
      stored=$(python3 -c 'import json,sys
try:
    d=json.load(open(sys.argv[1],encoding="utf-8"))
except Exception:
    print("unknown")
    raise SystemExit
if isinstance(d, dict) and d.get("stored") is True:
    raw=d.get("interval_seconds")
    try:
        print("yes %d" % int(raw))
    except (TypeError, ValueError):
        print("yes")
elif isinstance(d, dict):
    print(d.get("reason") or "skip")
else:
    print("unknown")' "${CORAX_WORKDIR}/audit_post.txt" 2>/dev/null || printf '%s' unknown)
      learned=
      case "$stored" in
        yes\ *)
          learned=${stored#yes }
          stored=yes
          ;;
      esac
      if [ "$stored" = "yes" ]; then
        case "$learned" in
          ''|*[!0-9]*) ;;
          0)
            publish_interval poll 15
            iv_sec=0
            ;;
          *)
            publish_interval pace "$learned"
            iv_sec=$learned
            ;;
        esac
        keep=$iv_sec
        if [ "$mode" = "now" ] && [ -z "$learned" ]; then
          saved=$(stamp_seconds)
          case "$saved" in
            ''|*[!0-9]*) ;;
            *) keep=$saved ;;
          esac
        fi
        write_stamp "$keep"
        log "audit: stored $hn via $uri"
        printf 'OK %s\n' "$hn"
        return 0
      fi
      if [ "$stored" = "unknown" ]; then
        log "audit: HTTP $code is not a CORAX reply, trying next ($uri)"
        continue
      fi
      log "audit: panel did not store ($stored) via $uri"
      if [ "$stored" = "disabled" ]; then
        return 2
      fi
      return 1
    done
  done
  return 1
}

if [ "$mode" = "loop" ]; then
  while :; do
    CORAX_AUDIT_INSIDE_LOOP=1 /bin/sh "$0" --tick || true
    kind=pace
    sec=15
    if [ -f "$AGENT_ROOT/.corax-audit-interval" ]; then
      kind=$(awk 'NR==1 { print $1 }' "$AGENT_ROOT/.corax-audit-interval" 2>/dev/null || true)
      sec=$(awk 'NR==1 { print $2 }' "$AGENT_ROOT/.corax-audit-interval" 2>/dev/null || true)
    fi
    case "$sec" in
      ''|*[!0-9]*) sec=15 ;;
    esac
    if [ "$kind" = "pace" ]; then
      age=$(stamp_age) || age=999999
      wait=1
      wait=$((sec - age)) || wait=1
      if [ "$wait" -lt 1 ]; then
        wait=1
      fi
    else
      wait=$sec
      if [ "$wait" -lt 5 ]; then
        wait=5
      fi
    fi
    # Wake at least every 15s so a change from 1 min to 15s is not stuck
    # behind the old sleep. The tick sends only when the stamp is due.
    if [ "$wait" -gt 15 ]; then
      wait=15
    fi
    log "audit: schedule ${sec}s, sleep ${wait}s"
    sleep "$wait" || true
  done
fi

asked=0
flag=bad
iv=5
iv_sec=300
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
  case "$iv_sec" in
    ''|*[!0-9]*) iv_sec=300 ;;
  esac
  if [ "${reason:-}" = "disabled" ]; then
    publish_interval poll 30
    log "audit: host disabled"
    exit 0
  fi
  if [ "$flag" = "yes" ] || [ "$flag" = "no" ]; then
    if have_cmd python3 && [ -s "${CORAX_WORKDIR}/audit_directive.json" ]; then
      python3 "$AGENT_ROOT/lib/run_jobs.py" "${CORAX_WORKDIR}/audit_directive.json" || true
    fi
  fi
  age=$(stamp_age)
  if [ "$flag" = "yes" ]; then
    log "audit: panel asked, sending"
    asked=1
  elif [ "$flag" = "no" ]; then
    if [ "$iv_sec" -le 0 ]; then
      log "audit: manual, waiting for the button"
      exit 0
    fi
    if [ "$age" -ge "$iv_sec" ]; then
      log "audit: ${iv_sec}s elapsed (${age}s), sending"
      asked=1
    else
      log "audit: idle, next in $((iv_sec - age))s"
      exit 0
    fi
  else
    saved=$(stamp_seconds)
    need=
    need_kind=
    if [ -f "$AGENT_ROOT/.corax-audit-interval" ]; then
      need_kind=$(awk 'NR==1 { print $1 }' "$AGENT_ROOT/.corax-audit-interval" 2>/dev/null || true)
      need=$(awk 'NR==1 { print $2 }' "$AGENT_ROOT/.corax-audit-interval" 2>/dev/null || true)
    fi
    if [ "$need_kind" = "poll" ]; then
      publish_interval poll 15
      log "audit: panel silent, manual mode, skip"
      exit 0
    fi
    case "$need" in
      ''|*[!0-9]*)
        case "${CORAX_AUDIT_INTERVAL:-}" in
          ''|*[!0-9]*) need=$saved ;;
          *) need=$CORAX_AUDIT_INTERVAL ;;
        esac
        ;;
    esac
    case "$need" in
      ''|*[!0-9]*) need=300 ;;
      0)
        publish_interval poll 15
        log "audit: panel silent, manual mode, skip"
        exit 0
        ;;
    esac
    publish_interval pace "$need"
    if [ "$age" -ge "$need" ]; then
      log "audit: panel silent for ${age}s, sending"
      iv_sec=$need
      asked=1
    else
      log "audit: panel silent, last sample ${age}s ago, skip"
      exit 0
    fi
  fi
fi

send_sample
rc=$?
if [ "$rc" -eq 2 ]; then
  exit 0
fi
if [ "$rc" -ne 0 ]; then
  exit 1
fi
# A minute cron without the service still fills the rest of that minute.
# The --loop parent sleeps the interval itself, so --tick must not stay awake.
if [ "$mode" = "cron" ] && [ "$iv_sec" -ge 15 ] && [ "$iv_sec" -lt 60 ]; then
  begin=$(date +%s 2>/dev/null || printf '%s' 0)
  while :; do
    now=$(date +%s 2>/dev/null || printf '%s' 0)
    if [ $((now - begin + iv_sec)) -ge 52 ]; then
      break
    fi
    sleep "$iv_sec"
    send_sample
    rc=$?
    if [ "$rc" -eq 2 ]; then
      exit 0
    fi
    if [ "$rc" -ne 0 ]; then
      exit 1
    fi
  done
fi
exit 0
