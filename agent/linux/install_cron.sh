#!/bin/sh
# Install weekly cron job for CORAX Linux agent
# Run once: sudo ./install_cron.sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT="$ROOT/inventory_agent.sh"
chmod +x "$AGENT" "$ROOT/corax_send.sh" 2>/dev/null || true

LINE="15 9 * * 1 root /bin/sh $AGENT >> /var/log/corax-agent.log 2>&1"
if [ -d /etc/cron.d ]; then
  printf '%s\n' "$LINE" >/etc/cron.d/corax-agent
  chmod 644 /etc/cron.d/corax-agent
  echo "Installed /etc/cron.d/corax-agent (Mon 09:15)"
  exit 0
fi
echo "No /etc/cron.d — add manually to crontab:"
echo "15 9 * * 1 /bin/sh $AGENT"
