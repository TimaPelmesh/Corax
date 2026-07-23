#!/usr/bin/env bash
# Авто-обновление CORAX на Linux-сервере.
#
# Docker (рекомендуется, ВМ / production):
#   git pull → ensure_docker_env → docker compose up -d --build → health
#   НЕ делает pip/npm build на хосте и НЕ трогает systemd.
#
# Bare-metal systemd (старый путь):
#   CORAX_DEPLOY=systemd /opt/corax/update.sh
#
# Установка:
#   chmod +x /opt/corax/update.sh
# Cron (ежедневно в 04:00, от root):
#   0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
# Если cron от root и репо принадлежит другому user:
#   git config --global --add safe.directory /opt/corax
#
# Переменные:
#   CORAX_ROOT=/opt/corax
#   CORAX_BRANCH=main
#   CORAX_DEPLOY=auto|docker|systemd   (default: auto)
#   CORAX_HEALTH_URL=http://127.0.0.1:3000/api/v1/health/ready
#   CORAX_HEALTH_RETRIES=30
#   CORAX_HEALTH_SLEEP=5

set -euo pipefail

ROOT="${CORAX_ROOT:-/opt/corax}"
BRANCH="${CORAX_BRANCH:-main}"
DEPLOY="${CORAX_DEPLOY:-auto}"
HEALTH_URL="${CORAX_HEALTH_URL:-http://127.0.0.1:3000/api/v1/health/ready}"
HEALTH_RETRIES="${CORAX_HEALTH_RETRIES:-30}"
HEALTH_SLEEP="${CORAX_HEALTH_SLEEP:-5}"

cd "$ROOT" || {
  echo "Не найден каталог $ROOT"
  exit 1
}

echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Начинаем обновление CORAX (deploy=${DEPLOY}) ==="

detect_deploy() {
  if [[ "$DEPLOY" == "docker" || "$DEPLOY" == "systemd" ]]; then
    echo "$DEPLOY"
    return
  fi
  # auto: Docker, если есть compose и docker CLI
  if [[ -f "$ROOT/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1; then
      echo "docker"
      return
    fi
  fi
  echo "systemd"
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose --env-file "$ROOT/backend/.env" "$@"
  else
    docker-compose --env-file "$ROOT/backend/.env" "$@"
  fi
}

git_pull() {
  if [[ ! -d .git ]]; then
    echo "Предупреждение: $ROOT не git-репозиторий — пропускаем pull"
    return 0
  fi
  echo "git fetch/pull origin ${BRANCH} ..."
  git fetch origin "$BRANCH"
  git pull --ff-only origin "$BRANCH"
}

wait_health() {
  local i=1
  echo "Ожидание health: ${HEALTH_URL} (до $((HEALTH_RETRIES * HEALTH_SLEEP)) с) ..."
  while [[ "$i" -le "$HEALTH_RETRIES" ]]; do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "Health OK: $HEALTH_URL"
      return 0
    fi
    # HTTPS mode on same port (local CA inside container / host may be untrusted)
    if curl -fsSk "https://127.0.0.1:3000/api/v1/health/ready" >/dev/null 2>&1; then
      echo "Health OK: https://127.0.0.1:3000/api/v1/health/ready"
      return 0
    fi
    if curl -fsS "http://127.0.0.1:3000/api/v1/health/ready" >/dev/null 2>&1; then
      echo "Health OK: http://127.0.0.1:3000/api/v1/health/ready"
      return 0
    fi
    if curl -fsS "http://127.0.0.1:3000/api/v1/health" >/dev/null 2>&1; then
      echo "Health OK: http://127.0.0.1:3000/api/v1/health"
      return 0
    fi
    sleep "$HEALTH_SLEEP"
    i=$((i + 1))
  done
  echo "ОШИБКА: healthcheck не ответил"
  return 1
}

update_docker() {
  echo "Режим: Docker Compose"

  if [[ ! -f "$ROOT/backend/.env" ]]; then
    echo "Нет backend/.env — запускаем ensure_docker_env.py"
  fi

  if [[ -f "$ROOT/scripts/ensure_docker_env.py" ]]; then
    if command -v python3 >/dev/null 2>&1; then
      python3 "$ROOT/scripts/ensure_docker_env.py"
    elif command -v python >/dev/null 2>&1; then
      python "$ROOT/scripts/ensure_docker_env.py"
    else
      echo "ОШИБКА: нужен python3 для scripts/ensure_docker_env.py"
      exit 1
    fi
  fi

  if [[ ! -f "$ROOT/backend/.env" ]]; then
    echo "ОШИБКА: backend/.env не создан"
    exit 1
  fi

  echo "docker compose up -d --build ..."
  compose up -d --build

  echo "Статус:"
  compose ps || true

  if ! wait_health; then
    echo "Логи app (последние 80 строк):"
    compose logs --tail 80 app || docker logs --tail 80 corax-app-1 || true
    exit 1
  fi
}

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

update_systemd() {
  echo "Режим: systemd (bare-metal) — pip/npm/build на хосте"

  # Python-зависимости
  VENV_PIP="$ROOT/.venv/bin/pip"
  if [ -x "$VENV_PIP" ] && [ -f "$ROOT/backend/requirements.txt" ]; then
    echo "pip install -r backend/requirements.txt ..."
    "$VENV_PIP" install -r "$ROOT/backend/requirements.txt"
  elif [ -f "$ROOT/backend/requirements.txt" ]; then
    echo "ОШИБКА: нет $ROOT/.venv — создайте: python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt"
    exit 1
  fi

  # Node + UI build
  if [ -f "$ROOT/package.json" ]; then
    echo "npm install ..."
    npm install --prefix "$ROOT"
    echo "npm run build ..."
    npm run build --prefix "$ROOT"
  fi

  echo "Перезапуск systemd..."
  restart_unit corax-backend
  if systemctl is-enabled corax-frontend.service &>/dev/null; then
    restart_unit corax-frontend
  fi

  if ! wait_health; then
    if curl -fsS "http://127.0.0.1:3001/api/v1/health" >/dev/null 2>&1; then
      echo "Health OK: http://127.0.0.1:3001/api/v1/health"
      return 0
    fi
    echo "Проверьте: journalctl -u corax-backend -n 50"
    exit 1
  fi
}

# --- main ---
MODE="$(detect_deploy)"
git_pull

case "$MODE" in
  docker) update_docker ;;
  systemd) update_systemd ;;
  *)
    echo "Неизвестный CORAX_DEPLOY=$MODE"
    exit 1
    ;;
esac

echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Обновление CORAX завершено (mode=${MODE}) ==="
