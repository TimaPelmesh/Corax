# CORAX — Docker

Первый запуск: **[GETTING_STARTED.md](../GETTING_STARTED.md)**. Здесь — ops: HTTPS, бэкапы, cron, типичные проблемы.

Канон: UI + API + PostgreSQL + ночные бэкапы. Только Docker. Запуск: `npm run docker:up`. `update.sh` — по желанию, не обязателен для работы парка.

## Стек

| Контейнер | Роль | Порт с хоста |
|-----------|------|----------------|
| `corax-app-1` | UI + API | **3000** → 3000 |
| `corax-db-1` | PostgreSQL 16 | только `127.0.0.1:5433` |
| `corax-db-backup-1` | ночной `pg_dump` + ротация | нет |

Volumes (`corax_pgdata`, `corax_data`, `corax_backups`) переживают `docker:down`.

## Требования

Linux (Ubuntu 22.04/24.04), Docker Engine 24+ / Compose v2, Git, Node.js 20+ (скрипты `npm run docker:*`), python3 (stdlib).

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 git curl ca-certificates
sudo usermod -aG docker "$USER"
# выйти из SSH и зайти снова
docker ps   # без sudo
```

Пока группа не применилась: `sudo npm run docker:up`.

## С нуля

```bash
sudo mkdir -p /opt/corax
sudo chown "$USER:$USER" /opt/corax
git clone https://github.com/TimaPelmesh/Corax.git /opt/corax
cd /opt/corax
npm run docker:up
```

`docker:up`:

1. Нет `backend/.env` → создаёт из example: admin=`admin123`, Postgres=`inventory`, сильные JWT/agent.
2. Есть `.env` → секреты **не** ротирует.
3. Первый create пишет логин в `backend/.docker-credentials`.
4. Собирает образ `corax:local` **только если его нет** или сменился код образа / рабочее дерево. Иначе просто `compose up -d`.
5. Ждёт `GET /api/v1/health/ready`.

`npm ci` в корне не нужен для запуска (это Playwright для тестов).

## Без обновлений

Образ `corax:local` — снимок на диске. Пока вы не делаете `docker:rebuild` / `update.sh`, стек не подтягивает новые Node/Debian/Postgres с Docker Hub (`pull_policy: missing` / `never`). Volumes переживают ребут и `docker:down`. Ночной cron не обязателен.

Не пересобирайте «на всякий случай» через год: тогда `FROM node:20-bookworm-slim` может уже значить другой дистрибутив. Работающий контейнер трогать не нужно.

Принудительно: `npm run docker:rebuild` или `CORAX_FORCE_BUILD=1`.

### Первый вход

| | |
|--|--|
| Username | `admin` |
| Password | `admin123` |

Сразу после входа панель **требует свой пароль**. Без смены API панели (кроме смены пароля и выхода) отвечает `403 password_change_required`.

`BOOTSTRAP_ADMIN_*` создаёт admin **только если таблица users пустая**. Правка `.env` на живой БД пароль входа не меняет.

```bash
cat backend/.docker-credentials
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

`docker:up` сам ждёт health. Ручной curl — проверка, не обязательный шаг.

Панель: `http://127.0.0.1:3000/` · из LAN: `http://<LAN-IP>:3000/`

### Фаервол

```bash
sudo ufw allow OpenSSH
sudo ufw allow 3000/tcp comment 'CORAX'
sudo ufw enable
```

### LAN

В `backend/.env`:

```env
CORAX_ADVERTISE_HOST=192.168.x.x
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://192.168.x.x:3000
# HTTPS: добавьте https://192.168.x.x:3000,https://localhost:3000
```

```bash
npm run docker:restart
```

Открывайте панель по `http://<LAN-IP>:3000` — сборка агента подставит URL.

Агенты (EXE / ZIP Windows / ZIP Linux, куда класть, как обновлять без потери токена): **[docs/agents.md](agents.md)**. В панели: **База знаний → Руководство**.

## Команды

| Действие | Команда |
|----------|---------|
| Поднять | `npm run docker:up` |
| Пересобрать образ | `npm run docker:rebuild` |
| Только `.env` | `npm run docker:init` |
| Статус | `npm run docker:ps` |
| Логи | `npm run docker:logs` |
| Перезапуск | `npm run docker:restart` |
| Стоп (данные живы) | `npm run docker:down` |

Без npm:

```bash
python3 scripts/ensure_docker_env.py
docker compose --env-file backend/.env up -d
docker compose --env-file backend/.env up -d --build   # только если нужен новый образ
docker compose --env-file backend/.env down
docker compose --env-file backend/.env logs -f
```

## Обновления (не обязательны)

Парк работает и без этого. Имеет смысл, только если нужны новые фичи с GitHub. Не делайте `docker:rebuild` «на всякий случай».

```bash
cd /opt/corax
git pull --ff-only
npm run docker:up
```

Ночной cron — [`update.sh`](../update.sh): `git pull` → `ensure_docker_env` → `compose up -d` (сборка образа только если сменились Dockerfile / lock / код в образе; иначе без `--build`). Слойный кэш BuildKit + `cache_from: corax:local`. Принудительно: `CORAX_FORCE_BUILD=1`.

```bash
sudo chmod +x /opt/corax/update.sh
sudo git config --global --add safe.directory /opt/corax
sudo crontab -e
```

```cron
0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
```

Без `CORAX_DEPLOY` и без других скриптов. Если в crontab ещё есть `scripts/corax-docker-update.sh` или symlink `corax-update.sh` — удалите:

```bash
rm -f /opt/corax/scripts/corax-docker-update.sh /opt/corax/corax-update.sh
```

| Сохраняется | Пересобирается |
|-------------|----------------|
| `backend/.env`, volumes | образ `corax:local`, контейнеры |
| данные парка / заявок | код и зависимости внутри образа |

Чистый стенд (сотрёт БД):

```bash
npm run docker:down
docker compose --env-file backend/.env down -v
npm run docker:up
```

## HTTPS

Один порт `:3000` = одна схема. Настройки → HTTPS:

| Режим | URL | Доверие |
|-------|-----|--------|
| HTTP (LAN) | `http://IP:3000` | не нужно |
| HTTPS + Local CA | `https://…` | `ca.crt` на ПК (`scripts/install-corax-ca.bat /machine` или GPO) |
| HTTPS + корпоративный CA | `https://…` | корень AD; leaf+key в UI |

После смены: `npm run docker:restart`, **пересоберите агентов**. В `CORS_ORIGINS` добавьте `https://…`.

Куки после HTTP↔HTTPS: открывать той же схемой или очистить cookie origin.

Health после TLS: `curl -fsSk https://127.0.0.1:3000/api/v1/health/ready`

## Бэкап

Volume `corax_backups` + **Настройки → База данных**.

```bash
docker compose --env-file backend/.env exec db-backup ls -la /backups
```

## Типичные проблемы

| Симптом | Решение |
|---------|---------|
| `permission denied … docker.sock` | группа `docker` или `sudo` |
| `python: not found` при sudo npm | есть `python3`; `docker:init` выбирает сам |
| `curl: connection reset` сразу после up | подождать 10–20 с; `docker logs corax-app-1` |
| Забыли пароль admin | не ждите, что `BOOTSTRAP_ADMIN_PASSWORD` обновит живого пользователя |
| Сменили `POSTGRES_PASSWORD`, БД не пускает | вернуть старый пароль в `.env` (volume помнит старый) |
| Агенты молчат | UFW 3000; LAN-IP в сборке, не localhost / не 172.x |
| Вход сломан после HTTP↔HTTPS | очистить куки origin |
| После входа «пустая» панель / 403 | смените базовый `admin123` на свой пароль |
