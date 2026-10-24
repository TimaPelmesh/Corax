#!/bin/sh
# Install weekly cron job for CORAX Linux agent
# Run once: sudo ./install_cron.sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export AGENT_ROOT=$ROOT
# shellcheck disable=SC1091
. "$ROOT/lib/common.sh"
AGENT="$ROOT/inventory_agent.sh"
AUDIT="$ROOT/corax_send.sh"
chmod +x "$AGENT" "$AUDIT" "$ROOT/corax_send.sh" "$ROOT/update_scripts.sh" 2>/dev/null || true
if ! refuse_if_inside_corax_server; then
  exit 2
fi
ensure_nightly_script_update || true

LINE="15 9 * * 1 root /bin/sh $AGENT >> /var/log/corax-agent.log 2>&1"
# Every minute. --cron sends when the panel asked, on the interval, or if the panel is silent.
AUDIT_LINE="* * * * * root /bin/sh $AUDIT --cron >> /var/log/corax-audit.log 2>&1"
if [ -d /etc/cron.d ]; then
  printf '%s\n%s\n' "$LINE" "$AUDIT_LINE" >/etc/cron.d/corax-agent
  chmod 644 /etc/cron.d/corax-agent
  echo "Installed /etc/cron.d/corax-agent"
  echo "  inventory: Mon 09:15"
  echo "  server audit: every minute via corax_send.sh --cron"
  echo "  scripts: every day 04:00 via update_scripts.sh"
  exit 0
fi
echo "No /etc/cron.d — add manually to crontab:"
echo "15 9 * * 1 /bin/sh $AGENT"
echo "* * * * * /bin/sh $AUDIT --cron"
echo "0 4 * * * /bin/sh $ROOT/update_scripts.sh"
