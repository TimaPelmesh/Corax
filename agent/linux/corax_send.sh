#!/bin/sh
# Thin wrapper → run_console.sh
cd "$(dirname "$0")" || exit 1
exec /bin/sh ./run_console.sh "$@"
