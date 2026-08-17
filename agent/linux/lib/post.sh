#!/bin/sh
# CORAX Agent — POST inventory JSON (curl or wget)
# shellcheck shell=sh

post_inventory() {
  json_file="$1"
  base_url="$2"
  token="$3"

  base=$(printf '%s' "$base_url" | sed 's|/*$||')
  host_port=$(printf '%s' "$base" | sed 's#^https\{0,1\}://##')
  scheme=http
  case "$base" in
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

  paths="/api/v1/agent/inventory /api/agent/inventory"
  queue_dir="${CORAX_QUEUE_DIR:-${HOME:-/tmp}/.corax-agent}"
  mkdir -p "$queue_dir" 2>/dev/null || true
  pending="$queue_dir/pending_report.json"

  http_post() {
    uri="$1"
    body_file="${CORAX_WORKDIR:-/tmp}/http_body.txt"
    code=""
    if have_cmd curl; then
      # Do NOT append || echo 000 — curl already prints 000 on connect fail,
      # and a non-zero exit would duplicate it ("000000").
      code=$(curl -sS -o "$body_file" -w '%{http_code}' \
        --connect-timeout 8 --max-time 90 \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        --data-binary @"$json_file" \
        "$uri" 2>/dev/null) || true
    elif have_cmd wget; then
      if wget -q -O "$body_file" \
        --timeout=90 \
        --header="Authorization: Bearer $token" \
        --header="Content-Type: application/json" \
        --post-file="$json_file" \
        "$uri" 2>/dev/null; then
        code=200
      else
        code=000
      fi
    else
      log "ERROR: need curl or wget to POST"
      code=000
    fi
    code=$(printf '%s' "$code" | tr -cd '0-9')
    case "$code" in
      ???) ;;
      *) code=000 ;;
    esac
    # Keep last 3 digits if somehow longer
    code=$(printf '%s' "$code" | awk '{print substr($0,length($0)-2)}')
    printf '%s' "$code"
  }

  if [ -f "$pending" ]; then
    log "retry pending report..."
    for p in $ports; do
      for path in $paths; do
        uri="${scheme}://${host}:${p}${path}"
        code=$(http_post "$uri")
        if [ "$code" = "200" ] || [ "$code" = "201" ]; then
          rm -f "$pending"
          log "pending OK via $uri"
          break 2
        fi
      done
    done
  fi

  ok=0
  last_code=000
  for p in $ports; do
    for path in $paths; do
      uri="${scheme}://${host}:${p}${path}"
      log "POST $uri"
      code=$(http_post "$uri")
      last_code=$code
      if [ "$code" = "200" ] || [ "$code" = "201" ]; then
        log "OK ($code) $(head -c 200 "${CORAX_WORKDIR:-/tmp}/http_body.txt" 2>/dev/null)"
        rm -f "$pending"
        ok=1
        break 2
      fi
      log "HTTP $code"
    done
  done

  if [ "$ok" -ne 1 ]; then
    cp -f "$json_file" "$pending" 2>/dev/null || true
    log "FAILED (last=$last_code) — saved $pending"
    return 1
  fi
  return 0
}
