#!/usr/bin/env bash
# Авто-обновление CORAX на Linux-сервере.
# Установка: chmod +x /opt/corax/update.sh
# Cron (ежедневно в 04:00, от root):
#   0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
#
# Переменные: CORAX_ROOT=/opt/corax  CORAX_BRANCH=main

set -euo pipefail

ROOT="${CORAX_ROOT:-/opt/corax}"
BRANCH="${CORAX_BRANCH:-main}"

cd "$ROOT" || {
  echo "Не найден каталог $ROOT"
  exit 1
}

echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Начинаем обновление CORAX ==="

restart_unit() {
  local unit="$1"
  if ! systemctl cat "${unit}.service" &>/dev/null; then
    echo "Служба ${unit} не установлена — пропуск"
    return 0
  fi
  if [ "$(id -u)" -eq 0 ]; then
    systemctl restart "${unit}.service"
  else
    sudo systemctl restart "${unit}.service"
  fi
  echo "Перезапущена: ${unit}"
}

# 1. Код с GitHub
if [ -d .git ]; then
  echo "git fetch/pull origin ${BRANCH} ..."
  git fetch origin "$BRANCH"
  git pull --ff-only origin "$BRANCH"
else
  echo "Предупреждение: $ROOT не git-репозиторий — пропускаем pull"
fi

# 2. Python-зависимости
VENV_PIP="$ROOT/.venv/bin/pip"
if [ -x "$VENV_PIP" ] && [ -f "$ROOT/backend/requirements.txt" ]; then
  echo "pip install -r backend/requirements.txt ..."
  "$VENV_PIP" install -r "$ROOT/backend/requirements.txt"
elif [ -f "$ROOT/backend/requirements.txt" ]; then
  echo "ОШИБКА: нет $ROOT/.venv — создайте: python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt"
  exit 1
fi

# 3. Node-зависимости + production-сборка UI
if [ -f "$ROOT/package.json" ]; then
  echo "npm install ..."
  npm install --prefix "$ROOT"
  echo "npm run build ..."
  npm run build --prefix "$ROOT"
fi

# 4. Перезапуск служб
echo "Перезапуск systemd..."
restart_unit corax-backend
if systemctl is-enabled corax-frontend.service &>/dev/null; then
  restart_unit corax-frontend
fi

echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Обновление CORAX завершено ==="
if curl -fsS "http://127.0.0.1:3000/api/v1/health" >/dev/null 2>&1; then
  echo "Health OK: http://127.0.0.1:3000/api/v1/health"
elif curl -fsS "http://127.0.0.1:3001/api/v1/health" >/dev/null 2>&1; then
  echo "Health OK: http://127.0.0.1:3001/api/v1/health"
else
  echo "Предупреждение: healthcheck не ответил — проверьте journalctl -u corax-backend -n 50"
  exit 1
fi
