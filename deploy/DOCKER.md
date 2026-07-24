# CORAX — Docker (рекомендуемый production / ВМ / LAN)

Полная инструкция по развёртыванию, проверенная на Linux-ВМ в LAN.  
Локальная разработка без Docker: `npm start` (см. [README](../README.md)).

## Что поднимается одной командой

| Контейнер | Роль | Порт с хоста |
|-----------|------|----------------|
| `corax-app-1` | UI + API (production) | **3000** → 3000 |
| `corax-db-1` | PostgreSQL 16 | только `127.0.0.1:5433` |
| `corax-db-backup-1` | ночной `pg_dump` + ротация | нет |

Данные в Docker volumes (`corax_pgdata`, `corax_data`, `corax_backups`) — переживают `docker:down`.

---

## Требования на сервере (ВМ)

| Компонент | Зачем |
|-----------|--------|
| Linux (Ubuntu 22.04/24.04 и т.п.) | хост |
| Docker Engine 24+ / Compose v2 | стек |
| Git | clone / обновления |
| Node.js 20+ (npm) | скрипты `npm run docker:*` |
| Python 3 (`python3`) | только `scripts/ensure_docker_env.py` (stdlib) |

Установка Docker (кратко, Ubuntu):

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 git curl ca-certificates
# Node 20 (если ещё нет):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### Права Docker (обязательно)

Без группы `docker` будет:

`permission denied … /var/run/docker.sock`

```bash
sudo usermod -aG docker "$USER"
# выйти из SSH и зайти снова, либо:
newgrp docker
docker ps   # должно работать БЕЗ sudo
```

Пока группа не применилась — можно `sudo docker …` / `sudo npm run docker:up`.

---

## Развёртывание с нуля (проверено)

```bash
sudo mkdir -p /opt/corax
sudo chown "$USER:$USER" /opt/corax
git clone https://github.com/TimaPelmesh/Corax.git /opt/corax
cd /opt/corax

# (опционально) npm install в корне — нужен для npm-скриптов, если package.json ещё не трогали
npm install --ignore-scripts   # или полный npm install

npm run docker:up
```

Что делает `docker:up`:

1. `docker:init` → `scripts/ensure_docker_env.py`:
   - нет `backend/.env` → создаёт из example + **сильные** секреты;
   - есть `.env` со слабыми/плейсхолдерами (`change-me`, `admin123`, `generate-with-…`) → **лечит** их;
   - сильные секреты **не** перезаписывает.
2. Печатает логин/пароль admin (если создал/вылечил) → файл `backend/.docker-credentials`.
3. `docker compose … up -d --build` → собирает образ `corax:local`, поднимает 3 контейнера.

### Логин (важно)

**Фиксированного пароля `admin123` для Docker нет.**

| Где смотреть | |
|--------------|--|
| Вывод первого `docker:up` / `docker:init` | Username / Password |
| Файл | `backend/.docker-credentials` |
| Вручную | `BOOTSTRAP_ADMIN_*` в `backend/.env` |

```bash
cat backend/.docker-credentials
```

После первого входа **смените пароль** в панели (Пользователи).

### Проверка, что стек жив

Подождите **10–20 секунд** после `Started` (миграции + uvicorn). Слишком ранний `curl` даёт `connection reset` — это не «всё сломано».

```bash
docker ps
# corax-app-1  → healthy (или starting → healthy)
# corax-db-1   → healthy

curl -fsS http://127.0.0.1:3000/api/v1/health/ready
# {"status":"ok","api":"v1","database":"up"}
# при HTTPS: curl -fsSk https://127.0.0.1:3000/api/v1/health/ready
```

Панель на сервере: `http://127.0.0.1:3000/`  
Из LAN: `http://<LAN-IP-ВМ>:3000/`

### Фаервол

```bash
sudo ufw allow OpenSSH
sudo ufw allow 3000/tcp comment 'CORAX'
sudo ufw enable
sudo ufw status

# с другого ПК:
curl -fsS http://<LAN-IP>:3000/api/v1/health/ready
```

### LAN для агентов и браузера (обязательно в офисе/лабе)

В `backend/.env` (подставьте IP ВМ):

```env
CORAX_ADVERTISE_HOST=192.168.x.x
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://192.168.x.x:3000
# При HTTPS добавьте: https://192.168.x.x:3000,https://localhost:3000
```

Применить:

```bash
npm run docker:restart
# или: docker compose --env-file backend/.env up -d
```

Открывайте панель именно по `http://<LAN-IP>:3000` — тогда сборка агента чаще подставляет правильный URL сама.

> В ответе `/api/v1/health` поле `lan_ip` внутри контейнера часто `null` (Docker не видит LAN). На агентов это не влияет, если задан `CORAX_ADVERTISE_HOST` или вы открыли панель по LAN-IP.

---

## Агенты (EXE / ZIP)

1. Войти в панель по **LAN-IP**.
2. **Настройки → Сборка агента** (`/settings/agent-bundle`).
3. Скачать **EXE (C++, рекомендуется)** или ZIP (Win10/11 / Win7) — вшиваются URL сервера и токен; схема `http`/`https` — по режиму TLS.
4. Раздать на ПК (шара / GPO / флешка), запустить.
5. Проверить появление хоста в **Парк ПК**.

Эндпоинт агента (тот же порт, что у панели):

```http
POST http://<LAN-IP>:3000/api/v1/agent/inventory
Authorization: Bearer <token>
```

Если агент «молчит»:

| Проверка | |
|----------|--|
| С ПК: `curl http://<LAN-IP>:3000/api/v1/health/ready` | сеть / firewall |
| URL в сборке не `127.0.0.1` и не `172.x` | `CORAX_ADVERTISE_HOST` / открыть панель по LAN |
| Токен не отозван | Настройки → Токены агентов |
| Логи | `npm run docker:logs` / `docker logs corax-app-1` |

---

## Где что настраивать

| Где | Что |
|-----|-----|
| Авто в `.env` | `SECRET_KEY`, `AGENT_TOKEN`, `AGENT_TOKEN_PEPPER`, `POSTGRES_PASSWORD`, bootstrap-пароль |
| **Веб-панель** | свой пароль, LDAP, Bitrix24, HTTPS, токены/сборка агентов, бэкап БД, склад, карта… |
| `.env` + restart | `CORS_ORIGINS`, `CORAX_ADVERTISE_HOST`, порты, LM Studio |

Секреты JWT / pepper / пароль Postgres из UI **не** правятся (инфраструктура контейнера).

---

## Обновления из GitHub (как жить дальше)

Ручной цикл:

```bash
cd /opt/corax
git pull --ff-only
npm run docker:up
```

### Ночной cron (рекомендуется)

В репозитории: [`update.sh`](../update.sh). На Docker-ВМ он делает **только**:
`git pull` → `ensure_docker_env` → `docker compose up -d --build` → health.  
**Не** гоняет `pip`/`npm build` на хосте и **не** трогает systemd.

```bash
sudo chmod +x /opt/corax/update.sh
# разовый прогон:
sudo /opt/corax/update.sh

# если cron от root, а репо принадлежит user:
sudo git config --global --add safe.directory /opt/corax

sudo crontab -e
```

```cron
0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
```

Лог: `sudo tail -n 100 /var/log/corax_update.log`

Явно Docker (если автоопределение мешает): `CORAX_DEPLOY=docker /opt/corax/update.sh`  
Старый bare-metal путь: `CORAX_DEPLOY=systemd /opt/corax/update.sh`

| Сохраняется | Пересобирается |
|-------------|----------------|
| `backend/.env`, volumes (БД, логи, TLS, бэкапы) | образ `corax:local`, контейнеры |
| данные парка / заявок | код, UI, зависимости **внутри образа** |

Миграции БД — при старте `app`. Откат кода: `git checkout <tag>` + снова `update.sh` / `docker:up`.

Чистый стенд «с нуля» (сотрёт БД):

```bash
npm run docker:down
docker compose --env-file backend/.env down -v   # ОПАСНО: удалит volumes
# при необходимости: rm backend/.env backend/.docker-credentials
npm run docker:up
```

---

## Команды

| Действие | Команда |
|----------|---------|
| Поднять / обновить | `npm run docker:up` |
| Только `.env` | `npm run docker:init` |
| Статус | `npm run docker:ps` |
| Логи | `npm run docker:logs` |
| Перезапуск | `npm run docker:restart` |
| Стоп (данные живы) | `npm run docker:down` |

Без npm:

```bash
python3 scripts/ensure_docker_env.py
docker compose --env-file backend/.env up -d --build
docker compose --env-file backend/.env down
docker compose --env-file backend/.env logs -f
```

---

## Типичные проблемы (с реальной ВМ)

| Симптом | Причина / решение |
|---------|-------------------|
| `permission denied … docker.sock` | пользователь не в группе `docker` (см. выше) или нужен `sudo` |
| `python: not found` при `sudo npm run docker:up` | на Linux нет `python`, есть `python3`; актуальный `docker:init` выбирает сам через `scripts/run_python.js` |
| `Refusing to start … default/empty secrets` | слабый `.env` → `python3 scripts/ensure_docker_env.py` (вылечит) + `docker compose … up -d` |
| `curl: connection reset` сразу после up | подождать 10–20 с, повторить; смотреть `docker logs corax-app-1` |
| app в Restarting | `docker logs --tail 100 corax-app-1` |
| Забыли пароль admin | `cat backend/.docker-credentials` |
| Сменили `POSTGRES_PASSWORD`, БД не пускает | volume со старым паролем → `down -v` (потеря данных) или вернуть старый пароль в `.env` |
| Агенты не достучались | UFW 3000; LAN-IP в EXE/ZIP; не localhost |
| app unhealthy после HTTPS | нормально чинится healthcheck `https -k \|\| http`; иначе `docker logs corax-app-1` |
| Вход не работает после смены HTTP↔HTTPS; в консоли «кука Secure уже существует» | Браузер держит старые `Secure`-куки `access_token`/`csrf_token`. Открывать той же схемой, что сервер, **или** очистить куки для этого origin и войти снова. См. [README](../README.md#важно-куки-после-смены-http--https) |

---

## HTTPS

Один порт (`3000`) = одна схема. Режимы в **Настройки → HTTPS**:

| Режим | Панель / агенты | Доверие |
|-------|-----------------|--------|
| **HTTP (LAN)** | `http://IP:3000` | не нужно |
| **HTTPS + CORAX Local CA** | `https://…` | `ca.crt` на ПК (GPO / `scripts/install-corax-ca.bat /machine`) |
| **HTTPS + корпоративный CA** | `https://…` | корень AD уже на машинах; импорт leaf+key в UI |

После смены режима: `npm run docker:restart` (или `docker compose restart app`).  
Пересоберите **EXE/ZIP** агента — схема берётся из статуса TLS (страница **Сборка агента**).  
В `CORS_ORIGINS` добавьте `https://<LAN-IP>:3000` (и localhost при необходимости).

**Healthcheck:** compose пробует `https://127.0.0.1:3000/.../ready` с `-k`, затем `http://…`.  
С хоста после TLS:

```bash
curl -fsSk https://127.0.0.1:3000/api/v1/health/ready
# или: CORAX_HEALTH_URL=https://127.0.0.1:3000/api/v1/health/ready ./update.sh
```

Файлы TLS в volume `corax_data` → `/data/tls` (не путать с хостовым `backend/data/tls` без bind-mount). Скачивайте CA из UI, а не с хоста.

1. Стек по HTTP, либо создайте/импортируйте сертификат в UI.
2. Включите нужный режим → restart.
3. Или `./scripts/setup-https.sh <IP>` (для Docker лучше генерировать **внутри** контейнера / через UI).

---

## Бэкап / restore

Ночные дампы: volume `corax_backups` (sidecar).  
Также **Настройки → База данных** в UI.

```bash
docker compose --env-file backend/.env exec db-backup ls -la /backups
```

---

## Альтернатива без Docker

Bare-metal systemd: [README — Linux](../README.md#linux-установка-с-нуля-systemd-cron).  
Для новых серверов предпочтителен **этот** Docker-стек.
