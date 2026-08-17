#!/bin/sh
# Update Linux agent scripts without replacing agent_env.sh (URL + token).
# Usage: /bin/sh ./update_scripts.sh /path/to/extracted-new-zip
# Run from the LIVE install dir (/opt/corax-agent).

set -eu
LIVE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
SRC=${1:-}
if [ -z "$SRC" ] || [ ! -f "$SRC/run_console.sh" ]; then
  echo "Usage: $0 /path/to/extracted-new-linux-zip" >&2
  echo "Keeps $LIVE/agent_env.sh" >&2
  exit 2
fi
SRC=$(CDPATH= cd -- "$SRC" && pwd)
if [ "$SRC" = "$LIVE" ]; then
  echo "ERROR: source and live dir are the same — extract the new ZIP elsewhere" >&2
  exit 1
fi
echo "Updating scripts in $LIVE"
echo "Keeping agent_env.sh"
# Copy everything except env (URL + token). Keep agent_config.json too unless missing.
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
chmod +x "$LIVE/run_console.sh" "$LIVE/corax_send.sh" "$LIVE/inventory_agent.sh" "$LIVE/install_cron.sh" "$LIVE/update_scripts.sh" 2>/dev/null || true
echo "Done. agent_env.sh was not replaced."
