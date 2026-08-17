#!/bin/sh
# CORAX Linux Agent — консольный запуск (интерактивно / из cron)
# Не трогает server .env и БД. Запускать из папки распакованного ZIP (/opt/corax-agent).
# shellcheck shell=sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT" || exit 1

echo "============================================"
echo " CORAX Linux Agent — консольный запуск"
echo " Каталог: $ROOT"
echo "============================================"

if [ ! -f "$ROOT/agent_env.sh" ]; then
  echo "ERROR: нет agent_env.sh"
  echo "  Нужен ZIP из панели (Сборка агента → ZIP Linux),"
  echo "  либо: cp agent_env.sh.example agent_env.sh и пропишите URL/токен."
  exit 2
fi

# shellcheck disable=SC1091
. "$ROOT/agent_env.sh"

case "${INVENTORY_SERVER:-}" in
  ''|__INVENTORY_SERVER__|*__*)
    echo "ERROR: INVENTORY_SERVER не настроен в agent_env.sh"
    exit 2
    ;;
esac
case "${AGENT_TOKEN:-}" in
  ''|__AGENT_TOKEN__|*__*|xxxx.yyyy)
    echo "ERROR: AGENT_TOKEN не настроен в agent_env.sh"
    exit 2
    ;;
esac

echo "Сервер: $INVENTORY_SERVER"
echo "Запуск сбора..."
echo ""

exec /bin/sh "$ROOT/inventory_agent.sh" "$@"
