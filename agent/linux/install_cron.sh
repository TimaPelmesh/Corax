#!/bin/sh
# Install weekly cron job for CORAX Linux agent
# Run once: sudo ./install_cron.sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT="$ROOT/inventory_agent.sh"
AUDIT="$ROOT/audit_agent.sh"
chmod +x "$AGENT" "$AUDIT" "$ROOT/corax_send.sh" 2>/dev/null || true

LINE="15 9 * * 1 root /bin/sh $AGENT >> /var/log/corax-agent.log 2>&1"
# Poll once a minute. The script exits immediately unless the panel asked for a sample.
AUDIT_LINE="* * * * * root /bin/sh $AUDIT >> /var/log/corax-audit.log 2>&1"
if [ -d /etc/cron.d ]; then
  printf '%s\n%s\n' "$LINE" "$AUDIT_LINE" >/etc/cron.d/corax-agent
  chmod 644 /etc/cron.d/corax-agent
  echo "Installed /etc/cron.d/corax-agent"
  echo "  inventory: Mon 09:15"
  echo "  server audit poll: every minute (samples only for hosts added in the panel)"
  exit 0
fi
echo "No /etc/cron.d — add manually to crontab:"
echo "15 9 * * 1 /bin/sh $AGENT"
echo "* * * * * /bin/sh $AUDIT"
