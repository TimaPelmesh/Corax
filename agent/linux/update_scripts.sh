#!/bin/sh
# Refresh Linux agent scripts. agent_env.sh (URL + token) is never replaced.
#
#   /bin/sh ./update_scripts.sh
#       download the scripts currently shipped by the panel.
#   /bin/sh ./update_scripts.sh /path/to/extracted-zip
#       apply a tree you already unpacked.
#
# Cron runs the first form at 04:00 by the host clock.
# shellcheck shell=sh

set -eu
LIVE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

apply_tree() {
  SRC=$1
  if [ -z "$SRC" ] || [ ! -f "$SRC/run_console.sh" ]; then
    echo "Usage: $0 [/path/to/extracted-new-linux-zip]" >&2
    echo "With no path, scripts are downloaded from the panel. agent_env.sh is kept." >&2
    exit 2
  fi
  SRC=$(CDPATH= cd -- "$SRC" && pwd)
  if [ "$SRC" = "$LIVE" ]; then
    echo "ERROR: source and live dir are the same — extract the new ZIP elsewhere" >&2
    exit 1
  fi
  echo "Updating scripts in $LIVE"
  echo "Keeping agent_env.sh"
  for f in "$SRC"/*; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    case "$base" in
      agent_env.sh) continue ;;
    esac
    if [ -d "$f" ]; then
      mkdir -p "$LIVE/$base"
      cp -R "$f"/. "$LIVE/$base"/
    else
      cp -f "$f" "$LIVE/$base"
    fi
  done
  chmod +x "$LIVE/run_console.sh" "$LIVE/corax_send.sh" "$LIVE/inventory_agent.sh" "$LIVE/audit_agent.sh" "$LIVE/install_cron.sh" "$LIVE/update_scripts.sh" 2>/dev/null || true
  if [ -f "$LIVE/lib/common.sh" ]; then
    AGENT_ROOT=$LIVE
    export AGENT_ROOT
    # shellcheck disable=SC1091
    . "$LIVE/lib/common.sh"
    # The running loop is the old script until its process is replaced.
    if ! install_audit_loop; then
      if command -v pkill >/dev/null 2>&1; then
        pkill -f '[a]udit_agent.sh --loop' >/dev/null 2>&1 || true
      fi
      ensure_background_loop || true
    elif command -v systemctl >/dev/null 2>&1; then
      restart_audit_service >/dev/null 2>&1 || true
    fi
  fi
  echo "Done. agent_env.sh was not replaced."
}

download_and_apply() {
  if [ -f "$LIVE/agent_env.sh" ]; then
    # shellcheck disable=SC1091
    . "$LIVE/agent_env.sh"
  fi
  base=${INVENTORY_SERVER:-}
  token=${AGENT_TOKEN:-}
  case "$base" in
    http://*|https://*) ;;
    *)
      echo "ERROR: INVENTORY_SERVER is not set in $LIVE/agent_env.sh" >&2
      exit 2
      ;;
  esac
  if [ "${#token}" -lt 8 ]; then
    echo "ERROR: AGENT_TOKEN is not set" >&2
    exit 2
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 is required to unpack the script zip" >&2
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "ERROR: curl or wget is required" >&2
    exit 1
  fi

  work=$(mktemp -d /tmp/corax-update.XXXXXX)
  trap 'rm -rf "$work"' EXIT INT TERM
  zip="$work/scripts.zip"

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

  fetch_zip() {
    uri=$1
    out=$2
    errf=$3
    rm -f "$out" "$errf"
    code=000
    if command -v curl >/dev/null 2>&1; then
      code=$(curl -sS -o "$out" -w '%{http_code}' \
        --connect-timeout 8 --max-time 90 \
        -H "Authorization: Bearer $token" \
        "$uri" 2>"$errf") || true
    elif command -v wget >/dev/null 2>&1; then
      if wget -O "$out" --timeout=90 --header="Authorization: Bearer $token" "$uri" >"$errf" 2>&1; then
        code=200
      fi
    fi
    code=$(printf '%s' "$code" | tr -cd '0-9')
    printf '%s' "$code"
  }

  is_zip() {
    python3 -c 'import sys; d=open(sys.argv[1],"rb").read(2); raise SystemExit(0 if d==b"PK" else 1)' "$1" 2>/dev/null
  }

  errf="$work/fetch.err"
  primary="${base_trim}/api/v1/agent/linux-scripts"
  code=$(fetch_zip "$primary" "$zip" "$errf")
  ok=0
  if [ "$code" = "200" ] && is_zip "$zip"; then
    echo "Downloaded $primary"
    ok=1
  else
    echo "Panel $primary answered HTTP ${code:-none}" >&2
    if [ -s "$errf" ]; then
      echo "fetch: $(head -c 400 "$errf")" >&2
    fi
    if [ -s "$zip" ] && ! is_zip "$zip"; then
      echo "Body is not a zip." >&2
    fi
  fi
  if [ "$ok" -ne 1 ] && { [ -z "$code" ] || [ "$code" = "000" ]; }; then
    for p in $ports; do
      for path in /api/v1/agent/linux-scripts /api/agent/linux-scripts; do
        uri="${scheme}://${host}:${p}${path}"
        [ "$uri" = "$primary" ] && continue
        code=$(fetch_zip "$uri" "$zip" "$errf")
        if [ "$code" = "200" ] && is_zip "$zip"; then
          echo "Downloaded $uri"
          ok=1
          break 2
        fi
      done
    done
    if [ "$ok" -ne 1 ]; then
      echo "ERROR: panel did not return a script zip. Check INVENTORY_SERVER in agent_env.sh." >&2
      exit 1
    fi
  elif [ "$ok" -ne 1 ]; then
    echo "ERROR: panel did not return a script zip" >&2
    exit 1
  fi

  python3 -c 'import sys, zipfile
from pathlib import Path
src = Path(sys.argv[2])
src.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(sys.argv[1]) as zf:
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        parts = [part for part in name.split("/") if part and part != "."]
        if not parts or any(part == ".." for part in parts) or name.startswith("/"):
            raise SystemExit("unsafe path in zip")
    zf.extractall(src)
' "$zip" "$work/src"

  apply_tree "$work/src"
}

if command -v flock >/dev/null 2>&1; then
  # Not /tmp: that directory is sticky and world-writable, so the kernel
  # (fs.protected_regular) rejects O_CREAT when the lock belongs to another
  # user. Root is not exempt. The agent directory is not shared that way.
  lock="$LIVE/.corax-update.lock"
  if [ ! -e "$lock" ]; then
    (umask 000; : >"$lock") || {
      echo "ERROR: cannot create $lock" >&2
      exit 1
    }
  fi
  chmod 666 "$lock" 2>/dev/null || true
  exec 9>"$lock" || {
    echo "ERROR: cannot open $lock" >&2
    exit 1
  }
  flock -n 9 || {
    echo "update already running"
    exit 0
  }
fi

if [ -n "${1:-}" ]; then
  apply_tree "$1"
else
  download_and_apply
fi
