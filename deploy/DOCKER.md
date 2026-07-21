# CORAX — Docker (рекомендуемый production)

## Зачем Docker

| Решение | Почему так |
|---------|------------|
| **Compose** (`db` + `app` + `db-backup`) | Один манифест: зависимости, volumes, restart, healthchecks |
| **Один `backend/.env`** | Те же секреты для local и Docker; не плодим корневой `.env` |
| **Postgres 16 в сервисе** | Данные в volume `corax_pgdata` |
| **Multi-stage Dockerfile** | Node только на сборке UI; runtime — slim Python |
| **Non-root `uid 10001`** | Меньше blast radius |
| **`/health/ready`** | Ready = Postgres отвечает |
| **Sidecar backup** | Ночной `pg_dump` + ротация |
| **Structured logs** | stdout + `/data/logs/corax.jsonl` (volume) |

## Быстрый старт

Требования: Docker Engine 24+ / Compose v2.

```bash
cp backend/.env.example backend/.env
# Заполните: SECRET_KEY, AGENT_TOKEN, AGENT_TOKEN_PEPPER,
# BOOTSTRAP_ADMIN_PASSWORD, POSTGRES_PASSWORD  (openssl rand -hex 32)

npm run docker:up      # поднять (build + start)
npm run docker:ps      # статус трёх контейнеров
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

Панель: `http://127.0.0.1:3000/` (логин = `BOOTSTRAP_*` из `backend/.env`).

Агентам: `http://<LAN-IP>:3000` (порт **3000**, тот же что у панели).

Фаервол хоста: откройте **TCP 3000** (UFW/iptables/cloud SG), иначе стек «healthy», а с других ПК не достучаться.

```bash
# пример Ubuntu
sudo ufw allow 3000/tcp
sudo ufw reload
# проверка с другой машины в LAN:
curl -fsS http://<LAN-IP>:3000/api/v1/health
```

Опционально в `backend/.env`: `CORAX_ADVERTISE_HOST=192.168.x.x` — явный IP для сборки агентов.
Если открыть панель уже по `http://192.168.x.x:3000`, IP подставится сам.

## Одна команда

| Действие | Команда |
|----------|---------|
| Поднять | `npm run docker:up` |
| Остановить | `npm run docker:down` |
| Перезапустить | `npm run docker:restart` |
| Логи | `npm run docker:logs` |
| Статус | `npm run docker:ps` |

Эквивалент без npm:

```bash
docker compose --env-file backend/.env up -d --build
docker compose --env-file backend/.env down
docker compose --env-file backend/.env restart
```

`docker:down` **сохраняет** volumes (БД, TLS, бэкапы). Удалить данные: `docker compose --env-file backend/.env down -v` (ОПАСНО).

## Секреты и безопасность

- Источник правды: **`backend/.env`** (в `.gitignore` и `.dockerignore` — не попадает в Git и в слои образа).
- В контейнере `ENVIRONMENT=production` всегда (даже если в файле `development` для `npm start`).
- Слабые/дефолтные секреты → отказ старта.
- По умолчанию: пустой `AGENT_INBOX_DIR`, `ALLOW_LEGACY_AGENT_TOKEN_HASHES=false`, OpenAPI выкл.
- Postgres с хоста только на `127.0.0.1` (см. `POSTGRES_PUBLISH_PORT`).

## Volumes

| Volume | Содержимое |
|--------|------------|
| `corax_pgdata` | PostgreSQL |
| `corax_data` | `/data/tls`, WikiRAG, **`/data/logs`**, (опц. inbox) |
| `corax_backups` | Ночные дампы (`-Fc`) |

```bash
npm run docker:logs
# Файловые логи приложения (JSON):
docker compose --env-file backend/.env exec app ls -la /data/logs
docker compose --env-file backend/.env exec db-backup ls -la /backups
```

## HTTPS

1. Поднимите стек по HTTP.
2. Admin → **Настройки → HTTPS** → CA → установить на админ-ПК → включить → `npm run docker:restart`.
3. Либо `./scripts/setup-https.sh <IP>` и файлы в volume `corax_data`.

## Обновление

```bash
git pull --ff-only
npm run docker:up
```

Миграции схемы — при старте app. Не гоняйте несколько реплик app без внешней блокировки migrate.

## Восстановление БД

```bash
docker compose --env-file backend/.env stop app
docker compose --env-file backend/.env exec db-backup ls /backups
# скопировать dump в контейнер db и pg_restore — см. ниже
docker cp ./your.dump corax-db-1:/tmp/restore.dump
docker compose --env-file backend/.env exec db \
  pg_restore -U inventory -d inventory --clean --if-exists /tmp/restore.dump
docker compose --env-file backend/.env start app
```

Либо **Настройки → База данных** в UI.

## Отладка

| Симптом | Что проверить |
|---------|----------------|
| `SECRET_KEY` required | Есть `backend/.env` с заполненными полями |
| app unhealthy | `npm run docker:logs`; Postgres healthy? |
| Production refuse defaults | Смените слабые секреты и пароль БД ≠ `inventory` |
| Ping ПК | В образе есть `iputils-ping`; сеть VM → LAN |
| LM Studio из Docker | `LM_STUDIO_BASE_URL=http://host.docker.internal:1234/v1` |

## Альтернатива: systemd без Docker

См. [README — Linux: systemd](../README.md#linux-установка-с-нуля-systemd-cron).
