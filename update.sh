#!/usr/bin/env bash
# Авто-обновление CORAX: только Docker.
#   git pull → ensure_docker_env → compose up -d
#   --build только если сменились Dockerfile / lock / код образа, или CORAX_FORCE_BUILD=1
#
#   chmod +x /opt/corax/update.sh
#   0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
#
#   CORAX_ROOT=/opt/corax
#   CORAX_BRANCH=main
#   CORAX_FORCE_BUILD=1          # всегда пересобрать образ
#   CORAX_HEALTH_URL=http://127.0.0.1:3000/api/v1/health/ready
#   CORAX_HEALTH_RETRIES=60
#   CORAX_HEALTH_SLEEP=5

set -euo pipefail

ROOT="${CORAX_ROOT:-/opt/corax}"
BRANCH="${CORAX_BRANCH:-main}"
HEALTH_URL="${CORAX_HEALTH_URL:-http://127.0.0.1:3000/api/v1/health/ready}"
HEALTH_RETRIES="${CORAX_HEALTH_RETRIES:-60}"
HEALTH_SLEEP="${CORAX_HEALTH_SLEEP:-5}"
FINGERPRINT_FILE="${CORAX_FINGERPRINT_FILE:-$ROOT/.corax-image-fingerprint}"

export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"
export COMPOSE_DOCKER_CLI_BUILD="${COMPOSE_DOCKER_CLI_BUILD:-1}"

cd "$ROOT" || {
  echo "Не найден каталог $ROOT"
  exit 1
}

if [[ ! -f "$ROOT/docker-compose.yml" ]]; then
  echo "ОШИБКА: нет docker-compose.yml — CORAX запускается только через Docker"
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "ОШИБКА: нужен docker"
  exit 1
fi

echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Начинаем обновление CORAX (Docker) ==="

compose() {
  if docker compose version >/dev/null 2>&1; then
    env -u AGENT_TOKEN -u SECRET_KEY -u AGENT_TOKEN_PEPPER \
      -u BOOTSTRAP_ADMIN_PASSWORD -u POSTGRES_PASSWORD -u POSTGRES_USER \
      -u DATABASE_URL -u AGENT_LEGACY_TOKENS \
      docker compose --env-file "$ROOT/backend/.env" "$@"
  else
    env -u AGENT_TOKEN -u SECRET_KEY -u AGENT_TOKEN_PEPPER \
      -u BOOTSTRAP_ADMIN_PASSWORD -u POSTGRES_PASSWORD -u POSTGRES_USER \
      -u DATABASE_URL -u AGENT_LEGACY_TOKENS \
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

# Content that is COPY'd into corax:local (skip --build when unchanged).
image_fingerprint() {
  if [[ -d .git ]] && command -v git >/dev/null 2>&1; then
    {
      git rev-parse \
        HEAD:Dockerfile \
        HEAD:docker-compose.yml \
        HEAD:.dockerignore \
        HEAD:frontend \
        HEAD:backend \
        HEAD:agent \
        HEAD:run.py \
        HEAD:scripts \
        HEAD:deploy/docker \
        2>/dev/null || true
    } | sha256sum | awk '{print $1}'
    return 0
  fi
  {
    cat Dockerfile docker-compose.yml .dockerignore \
      frontend/package-lock.json frontend/package.json \
      backend/requirements.txt 2>/dev/null || true
  } | sha256sum | awk '{print $1}'
}

image_exists() {
  docker image inspect corax:local >/dev/null 2>&1
}

need_image_build() {
  if [[ "${CORAX_FORCE_BUILD:-0}" == "1" ]]; then
    echo "force"
    return 0
  fi
  if ! image_exists; then
    echo "missing-image"
    return 0
  fi
  local now prev
  now="$(image_fingerprint)"
  prev="$(cat "$FINGERPRINT_FILE" 2>/dev/null || true)"
  if [[ -z "$now" ]]; then
    echo "no-fingerprint"
    return 0
  fi
  if [[ "$now" != "$prev" ]]; then
    echo "fingerprint"
    return 0
  fi
  echo ""
  return 1
}

git_pull

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

BUILD_REASON=""
if BUILD_REASON="$(need_image_build)"; then
  echo "docker compose build + up -d  (причина: ${BUILD_REASON}; BuildKit cache / corax:local)"
  echo "  полный apt/npm/pip — только если сменились Dockerfile или lock-файлы"
  compose build
  compose up -d
else
  echo "docker compose up -d  (без --build: Dockerfile/lock/код образа не менялись)"
  compose up -d
fi

echo "Статус:"
compose ps || true

if ! wait_health; then
  echo "ОШИБКА health — чаще всего: app ещё стартует, или password auth failed"
  echo "  test -f backend/.env && echo '.env на месте' || echo '.env НЕТ'"
  echo "  docker compose --env-file backend/.env logs --tail 80 app db"
  compose logs --tail 80 app || docker logs --tail 80 corax-app-1 || true
  exit 1
fi

image_fingerprint >"$FINGERPRINT_FILE" || true

echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Обновление CORAX завершено (Docker) ==="
