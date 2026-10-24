#!/bin/sh
# CORAX cluster sender. One AGENT_TOKEN for every Linux host.
#
#   sudo ./corax_send.sh
# sends a report immediately and, as root, installs a minutely job.
# The job asks the panel and sends again when a button, the interval, or a
# silent panel says so. Copy this directory (with agent_env.sh) to each server.
#
#   ./corax_send.sh --server https://corax.example --token PREFIX.SECRET
# writes agent_env.sh, then sends.
# shellcheck shell=sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT" || exit 1
export AGENT_ROOT=$ROOT
# shellcheck disable=SC1091
. "$ROOT/lib/common.sh"

cron=0
server=
token=
while [ $# -gt 0 ]; do
  case $1 in
    --cron) cron=1 ;;
    --now) cron=0 ;;
    --server)
      shift
      server=${1:-}
      ;;
    --token)
      shift
      token=${1:-}
      ;;
    *)
      printf 'usage: %s [--cron] [--server URL --token TOKEN]\n' "$0" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -n "$server" ] || [ -n "$token" ]; then
  if [ -z "$server" ] || [ -z "$token" ]; then
    echo "ERROR: --server and --token are set together" >&2
    exit 2
  fi
  case "$server" in
    http://*|https://*) ;;
    *)
      echo "ERROR: --server must start with http:// or https://" >&2
      exit 2
      ;;
  esac
  umask 077
  printf '%s\n' "#!/bin/sh" "# One cluster token. Safe to copy onto every Linux host." "export INVENTORY_SERVER=\"${server%/}\"" "export AGENT_TOKEN=\"$token\"" >"$ROOT/agent_env.sh"
  chmod 600 "$ROOT/agent_env.sh" 2>/dev/null || true
fi

if ! refuse_if_inside_corax_server; then
  exit 2
fi
ensure_nightly_script_update || true

if [ "$cron" -eq 1 ]; then
  exec /bin/sh "$ROOT/audit_agent.sh"
fi

set +e
/bin/sh "$ROOT/audit_agent.sh" --now
sent=$?
set -e

if [ "$(id -u 2>/dev/null || echo 1)" -ne 0 ]; then
  if [ "$sent" -eq 0 ]; then
    echo "Report sent. Run once as root so the minute job stays installed:"
  else
    echo "Report was not stored. Run as root so the minute job keeps trying:"
  fi
  echo "  sudo $ROOT/corax_send.sh"
  echo "Root also installs the 04:00 script update."
  exit "$sent"
fi

minute_present() {
  [ -f "$1" ] || return 1
  if grep -E '^[^#]*\* \* \* \* \*.*(audit_agent\.sh|corax_send\.sh)' "$1" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

if [ ! -d /etc/cron.d ]; then
  echo "No /etc/cron.d. Add this to root crontab:"
  echo "* * * * * /bin/sh $ROOT/corax_send.sh --cron >> /var/log/corax-audit.log 2>&1"
  echo "0 4 * * * /bin/sh $ROOT/update_scripts.sh >> /var/log/corax-update.log 2>&1"
  exit "$sent"
fi

if minute_present /etc/cron.d/corax-agent || minute_present /etc/cron.d/corax-send; then
  echo "Minute job already installed"
  exit "$sent"
fi

printf '%s\n' "# CORAX cluster audit. One token, every host that runs this script." \
  "* * * * * root /bin/sh $ROOT/corax_send.sh --cron >> /var/log/corax-audit.log 2>&1" \
  > /etc/cron.d/corax-send
chmod 644 /etc/cron.d/corax-send
echo "Installed /etc/cron.d/corax-send (every minute)"
exit "$sent"
