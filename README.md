# CORAX

```
   ██████╗ ██████╗ ██████╗  █████╗ ██╗  ██╗
  ██╔════╝██╔═══██╗██╔══██╗██╔══██╗╚██╗██╔╝
  ██║     ██║   ██║██████╔╝███████║ ╚███╔╝
  ██║     ██║   ██║██╔══██╗██╔══██║ ██╔██╗
  ╚██████╗╚██████╔╝██║  ██║██║  ██║██╔╝ ██╗
   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
```

<p align="center">
  <strong>Inventory for the machines that actually work.</strong><br/>
  Открытая система инвентаризации парка ПК и лёгкого helpdesk — для LAN, а не для презентаций.
</p>

<p align="center">
  <a href="https://github.com/TimaPelmesh/Corax/actions/workflows/ci.yml"><img src="https://github.com/TimaPelmesh/Corax/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-1f6feb?style=flat-square" alt="License GPLv3" /></a>
  <img src="https://img.shields.io/badge/release-2.1.0-0e7c66?style=flat-square" alt="Release 2.1.0" />
  <img src="https://img.shields.io/badge/target-LAN%20%2F%20lab%20%2F%20office-6e7781?style=flat-square" alt="Target LAN" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/FastAPI-0.115-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/SQLAlchemy-2.0-D71F00?style=flat-square" alt="SQLAlchemy" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Tailwind-4-38BDF8?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/Agents-ZIP%20%7C%20PowerShell-111827?style=flat-square" alt="Agents" />
</p>

---

| Слой | Что делает CORAX |
|------|------------------|
| **Сбор** | Агенты Win (ZIP / PowerShell) отдают железо, ПО, периферию по LAN |
| **Панель** | Дашборд, карточки ПК, заявки, карта здания, склад, принтеры SNMP |
| **Интеграции** | LDAP (справочник), Bitrix24, WikiRAG + LM Studio, GLPI CSV |
| **Эксплуатация** | Один Docker-стек: UI+API+Postgres+ночные бэкапы |

CORAX принимает отчёты агентов в локальной сети, кладёт их в PostgreSQL и отдаёт веб-панель администратору — без облака, без «обязательной» подписки, без лишней магии.

**Production / ВМ:** Docker — [раздел ниже](#docker-рекомендуемый-способ-вм--production--lan) и **[deploy/DOCKER.md](deploy/DOCKER.md)** (`npm run docker:up`).  
**Dev на своём ПК:** `npm start` / `start_all.bat` (полная установка без Docker — ниже по README).

**Автор:** Иванов Тимур · **Лицензия:** [GNU GPL v3](LICENSE) · © 2026 · [CONTRIBUTING](CONTRIBUTING.md) · [CHANGELOG](CHANGELOG.md) · [RELEASE NOTES 2.1.0](RELEASE_NOTES_v2.1.0.md)

---

### Содержание

1. [Возможности](#возможности)
2. [Стек и зависимости](#стек-и-зависимости)
3. [Docker (рекомендуемый способ: ВМ / production / LAN)](#docker-рекомендуемый-способ-вм--production--lan)
4. [Полная инструкция по установке](#полная-инструкция-по-установке) — local без Docker (Windows / Linux)
5. [Быстрый старт](#быстрый-старт-кратко) — local `start_all`
6. [Архитектура и структура](#архитектура)
7. [Конфигурация](#конфигурация)
8. [Observability (логи)](#observability-логи)
9. [Агенты, заявки, карта, LDAP, Bitrix24](#агент-инвентаризации)
10. [Тесты](#тесты-и-проверки)
11. [Production checklist](#production-checklist)
12. [Linux: установка с нуля, systemd, cron](#linux-установка-с-нуля-systemd-cron) — альтернатива без Docker
13. [Эксплуатация и бэкапы](#эксплуатация)


## Docker (рекомендуемый способ: ВМ / production / LAN)

**Да — для сервера и лаборатории канонический путь сейчас Docker:** одна команда поднимает UI+API+Postgres+бэкапы.  
Локальная разработка UI/API без контейнеров по-прежнему: `npm start` (порты 3000/3001).

Полный боевой гайд (права Docker, фаервол, агенты, обновления, типичные ошибки с ВМ):  
**[deploy/DOCKER.md](deploy/DOCKER.md)**.

### Стек

| Компонент | Роль |
|-----------|------|
| `app` | UI + FastAPI на порту **3000** |
| `db` | PostgreSQL 16 (volume) |
| `db-backup` | ночные `pg_dump` |

### Развёртывание с нуля

```bash
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax
# Linux: пользователь должен быть в группе docker (см. deploy/DOCKER.md)
npm run docker:up
```

`docker:up` сам:

1. создаёт или **лечит** слабый `backend/.env` (сильные секреты);
2. пишет логин в `backend/.docker-credentials` (если создал/вылечил);
3. собирает образ и поднимает три контейнера.

**Пароля `admin/admin123` в Docker нет** — только то, что напечатал init / файл credentials:

```bash
cat backend/.docker-credentials
# подождите 10–20 с после старта, затем:
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

Панель: `http://<LAN-IP-сервера>:3000/` → смените пароль admin в UI.

| Где | Что |
|-----|-----|
| Авто в `.env` | JWT, pepper, пароль Postgres, bootstrap-пароль |
| Веб | свой пароль, LDAP, Bitrix, HTTPS, **сборка ZIP-агентов**, бэкап |
| `.env` + restart | `CORAX_ADVERTISE_HOST`, `CORS_ORIGINS` (LAN) |

Для агентов в LAN в `.env` задайте IP ВМ и перезапустите:

```env
CORAX_ADVERTISE_HOST=192.168.x.x
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://192.168.x.x:3000
```

```bash
npm run docker:restart
# Фаервол: sudo ufw allow 3000/tcp
# Агенты: Настройки → Сборка агента → ZIP на ПК
```

### Обновления из репозитория

```bash
cd /opt/corax   # или каталог клона
git pull --ff-only
npm run docker:up
# или ночной скрипт (тот же Docker-путь):
#   sudo /opt/corax/update.sh
```

Cron в 04:00 (уже мог быть настроен):

```cron
0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
```

Актуальный `update.sh` на Docker-ВМ **не** делает host `pip`/`npm build`/`systemctl` — только `git pull` + `docker compose up -d --build`. Подробности: [deploy/DOCKER.md](deploy/DOCKER.md#ночной-cron-рекомендуется).

| Сохраняется | Пересобирается |
|-------------|----------------|
| `backend/.env`, volumes (БД, логи, TLS, бэкапы) | образ `corax:local`, контейнеры |
| данные парка / заявок | код, UI, зависимости в образе |

Миграции БД — при старте `app`.

```bash
npm run docker:ps      # статус
npm run docker:logs    # логи
npm run docker:down    # стоп (volumes остаются)
```


## Возможности

- Дашборд по парку ПК: количество машин, ОС, производители, модели, RAM, диски, периферия, мониторы, пользователи и заявки.
- Инвентаризация ПК через агент: hostname, серийный номер, MAC, CPU, RAM, ОС, производитель, модель, GPU, материнская плата, диски, ПО и периферия.
- Карточки компьютеров: фильтры, поиск, редактирование заметок, кабинета, ответственного, тегов и просмотр истории изменений.
- Каталог ПО: список программ и компьютеров, где они установлены.
- Теги: справочник цветных меток для группировки компьютеров.
- Заявки: создание, база заявок, статусы, приоритеты, ответственные, шаблоны, статистика, импорт/экспорт GLPI CSV и PDF-выгрузка.
- Карта здания: этажи/планы, импорт PNG-фона, расстановка объектов, привязки к компьютерам/мониторам/пользователям/заявкам, экспорт SVG/PNG/PDF/JSON.
- Совместная работа с картой через WebSocket: пользователи видят правки и перемещения объектов в реальном времени.
- Пользователи и роли: локальные учётные записи CORAX (`observer`, `editor`, `admin`); LDAP/Bitrix24 — справочник для заявок без входа в панель.
- Токены агентов: выпуск, отзыв, привязка токена к hostname, хранение токенов в виде HMAC-хеша.
- Bitrix24: импорт пользователей через REST webhook, входящие события/заявки через защищённый endpoint, базовая bot-интеграция.
- Production checks: при `ENVIRONMENT=production` приложение не стартует с дефолтными секретами.
- Сборка агентов: ZIP (PowerShell) из веб-панели — IP и токен прописываются при сборке.

## Стек и зависимости

```
┌──────────────┐     Bearer / agents      ┌─────────────────────────────┐
│  Win agents  │ ───────────────────────► │  CORAX app (:3000)          │
│  ZIP / PS    │                          │  FastAPI + React SPA        │
└──────────────┘                          │  structured logs → stdout   │
                                          │            + /data/logs     │
┌──────────────┐     browser / LAN        │                             │
│  Admin UI    │ ───────────────────────► │  CSRF · JWT cookie · CSP    │
└──────────────┘                          └──────────────┬──────────────┘
                                                         │
                                                         ▼
                                          ┌─────────────────────────────┐
                                          │  PostgreSQL 16              │
                                          │  + nightly db-backup        │
                                          └─────────────────────────────┘
```

### Системные требования

| Компонент | Минимум | Рекомендуется |
|-----------|---------|---------------|
| ОС сервера | Windows 10/11, Ubuntu 22.04+, macOS 13+ | Windows Server / Ubuntu LTS |
| Python | 3.10 | 3.12 |
| PostgreSQL | 14 | 16 |
| Node.js | 18 LTS | 20 LTS |
| RAM (сервер) | 2 ГБ | 4+ ГБ |
| Диск | 2 ГБ свободно | 10+ ГБ (БД, логи, агенты) |

Опционально (по функциям):

| Компонент | Зачем |
|-----------|--------|
| LibreOffice (`soffice`) | Экспорт PDF/PNG карт (опционально) |
| LM Studio (локальный API) | WikiRAG — чат по базе знаний |
| Active Directory / LDAP | Синхронизация справочника для заявок |

### Backend (Python) — `backend/requirements.txt`

| Пакет | Версия | Назначение |
|-------|--------|------------|
| fastapi | 0.115.6 | HTTP API, OpenAPI |
| uvicorn[standard] | 0.32.1 | ASGI-сервер |
| sqlalchemy | 2.0.36 | ORM (работа с PostgreSQL) |
| asyncpg | 0.30.0 | Асинхронный драйвер PostgreSQL |
| greenlet | ≥3.0 | async SQLAlchemy |
| pydantic-settings | 2.6.1 | Конфиг из `.env` |
| python-jose[cryptography] | 3.3.0 | JWT |
| bcrypt | 4.2.1 | Хеши паролей |
| python-multipart | 0.0.17 | Загрузка файлов |
| ldap3 | — | LDAP-аутентификация |
| fpdf2 | 2.8.2 | PDF-выгрузка заявок |
| httpx | 0.28.1 | HTTP-клиент (интеграции) |
| pypdf | 5.1.0 | Обработка PDF (WikiRAG) |
| puresnmp | ≥2.0 | Опрос принтеров по SNMP |
| slowapi | 0.1.9 | Лимиты запросов (вход, агент) |
| psutil | 6.1.0 | Служебные метрики хоста |
| requests | 2.32.3 | HTTP-клиент |

### Frontend (Node.js) — `frontend/package.json`

**Runtime:**

| Пакет | Назначение |
|-------|------------|
| react, react-dom | UI |
| react-router-dom | Маршруты SPA |
| chart.js, react-chartjs-2 | Графики дашборда |
| reactflow | Карта здания |
| three | 3D-визуализация |
| tailwindcss | Стили |

**Dev / сборка:** TypeScript, Vite 8, ESLint, Vitest, Testing Library.

### Корень репозитория — `package.json`

| Пакет | Назначение |
|-------|------------|
| concurrently | Параллельный запуск API + Vite |
| cross-env | Переменные окружения в npm-скриптах |
| wait-on | Ожидание порта API перед стартом фронта |
| @playwright/test | E2E-тесты |

### Агенты

| Компонент | Назначение |
|-----------|------------|
| PowerShell v3 (`agent/v3/win10`) | Сбор Win10/11 → ZIP из панели |
| PowerShell Win7 (`agent/win7`) | Базовый сбор Win7 → ZIP |

Порты по умолчанию:

| Порт | Служба |
|------|--------|
| 5432 | PostgreSQL (local) |
| 3000 | UI + API (Docker / production) |
| 3001 | API only (development `npm start`) |
| 1234 | LM Studio (опционально) |

---

## Полная инструкция по установке

Ниже — пошаговая установка с нуля на **Windows** (основной сценарий для лаборатории) и кратко для **Linux**. После установки сервер принимает отчёты агентов в LAN, хранит данные в PostgreSQL и открывает веб-панель.

### Где скачать компоненты (официальные ссылки)

| Компонент | Рекомендуемая версия | Скачать | Примечание |
|-----------|---------------------|---------|------------|
| **Репозиторий CORAX** | `main` | [github.com/TimaPelmesh/Corax](https://github.com/TimaPelmesh/Corax) | `git clone` или ZIP «Code → Download ZIP» |
| **PostgreSQL** | **16** | [postgresql.org/download](https://www.postgresql.org/download/) | Windows: [EDB installer](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads) — в комплекте **pgAdmin 4** и служба |
| **Python** | **3.12+** | [python.org/downloads](https://www.python.org/downloads/) | Windows: галочка **«Add python.exe to PATH»** |
| **Node.js** | **20 LTS** | [nodejs.org/en/download](https://nodejs.org/en/download) | Нужен для сборки и dev-режима UI |
| **Git** (опционально) | актуальный | [git-scm.com/download/win](https://git-scm.com/download/win) | Для клонирования и обновлений |
| **LibreOffice** (опционально) | 7.x+ | [libreoffice.org/download](https://www.libreoffice.org/download/download/) | Карта здания: экспорт PDF/PNG планов |
| **LM Studio** (опционально) | актуальный | [lmstudio.ai](https://lmstudio.ai/) | WikiRAG — локальный чат по базе знаний |

**PostgreSQL — что выбрать на Windows:** установщик EDB → PostgreSQL 16 → Windows x86-64. Порт **5432**, locale **Russian, Russia** или **C** (UTF-8). Запомните пароль пользователя **`postgres`** — он понадобится в `POSTGRES_ADMIN_PASSWORD` в `backend/.env`.

**Альтернативы PostgreSQL (для опытных):** Docker-образ [`postgres:16`](https://hub.docker.com/_/postgres), пакетный менеджер Linux (`apt install postgresql`), Homebrew на macOS (`brew install postgresql@16`). CORAX рассчитан на локальный экземпляр на `localhost:5432`.

Подробнее о миграции со старого SQLite и смене API: **[MIGRATION.md](MIGRATION.md)**.

---

### Шаг 0. Клонирование репозитория

```powershell
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax
```

Или распакуйте архив проекта в удобную папку (для npm надёжнее путь без кириллицы).

---

### Шаг 1. Установка PostgreSQL

База данных **обязательна**. CORAX хранит в PostgreSQL: парк ПК, заявки, пользователей, карту здания, склад. По умолчанию — одна БД **`inventory`** на **`localhost:5432`**, три URL в `.env` (`DATABASE_URL`, `DIAGRAMS_DATABASE_URL`, `WAREHOUSE_DATABASE_URL`) могут указывать на **одну и ту же** базу.

| Параметр | Значение по умолчанию (после `ensure_postgres.py`) |
|----------|-----------------------------------------------------|
| Хост | `localhost` |
| Порт | `5432` |
| База | `inventory` |
| Пользователь приложения | `inventory` |
| Пароль приложения | `inventory` (в production смените в `.env` и в PostgreSQL) |
| Суперпользователь PG | `postgres` (только для первичной настройки) |

Скачать: [postgresql.org/download](https://www.postgresql.org/download/) · Windows (рекомендуется): [EDB PostgreSQL 16](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads) · GUI: **pgAdmin 4** (ставится вместе с EDB).

#### Windows

1. Скачайте [EDB installer для PostgreSQL 16](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads) (раздел Windows x86-64).
2. При установке запомните пароль суперпользователя **`postgres`**.
3. Порт оставьте **5432**, локаль — UTF-8.
4. Компоненты: **PostgreSQL Server**, **pgAdmin 4**, **Command Line Tools** (для `psql`, `pg_dump`).
5. После установки служба обычно называется `postgresql-x64-16`.

Проверка:

```powershell
Get-Service postgresql*
# или
sc query postgresql-x64-16
```

Запуск вручную:

```powershell
net start postgresql-x64-16
```

Автозапуск (от администратора):

```powershell
Set-Service -Name postgresql-x64-16 -StartupType Automatic
```

#### Linux (Ubuntu / Debian)

Пакеты из официального репозитория дистрибутива: [postgresql.org/download/linux](https://www.postgresql.org/download/linux/).

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql
sudo systemctl status postgresql
```

#### macOS

[postgresql.org/download/macosx](https://www.postgresql.org/download/macosx/) или Homebrew:

```bash
brew install postgresql@16
brew services start postgresql@16
```

#### Что делает проект автоматически

Скрипт `scripts/ensure_postgres.py` (вызывается из `run.py` и `start_all.bat`):

1. Пытается **запустить службу** PostgreSQL, если порт 5432 закрыт.
2. Создаёт роль **`inventory`** с паролем **`inventory`** (если нет).
3. Создаёт базу **`inventory`** (если нет).
4. При наличии старых SQLite-файлов в `backend/` — **один раз** переносит данные в PostgreSQL.

Для первичной настройки на Windows укажите в `backend/.env` пароль postgres:

```env
POSTGRES_ADMIN_PASSWORD=ваш-пароль-при-установке-postgres
```

**Рекомендация:** первый раз запустите `start_all.bat` **от имени администратора** — скрипт сможет поднять службу и выполнить dev-bootstrap через `pg_hba.conf`, если пароль ещё не совпал.

Ручная инициализация (если нужно):

```powershell
python scripts\ensure_postgres.py
```

Проверка подключения:

```powershell
# через psql (если установлен)
psql -U inventory -d inventory -h localhost -c "SELECT 1"
# пароль по умолчанию: inventory
```

---

### Шаг 2. Установка Python

1. Скачайте [Python 3.12](https://www.python.org/downloads/windows/).
2. В установщике включите **«Add python.exe to PATH»**.
3. Проверка:

```powershell
python --version
pip --version
```

Установка зависимостей backend:

```powershell
cd Corax
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

---

### Шаг 3. Установка Node.js

1. Скачайте [Node.js 20 LTS](https://nodejs.org/).
2. Проверка:

```powershell
node --version
npm --version
```

Установка npm-зависимостей (корень + frontend):

```powershell
npm install
```

---

### Шаг 4. Конфигурация `backend/.env`

```powershell
copy backend\.env.example backend\.env
```

Минимальный рабочий `.env` для разработки:

```env
ENVIRONMENT=development
SECRET_KEY=dev-secret-key-change-me
AGENT_TOKEN=dev-agent-token-change-in-production
AGENT_TOKEN_PEPPER=dev-pepper-change-in-production
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=admin123

DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
DIAGRAMS_DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
WAREHOUSE_DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory

POSTGRES_ADMIN_PASSWORD=ваш-пароль-postgres

CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173
```

| Переменная | Описание |
|------------|----------|
| `ENVIRONMENT` | `development` или `production` |
| `SECRET_KEY` | Подпись JWT (в production — случайная строка ≥32 символов) |
| `AGENT_TOKEN_PEPPER` | Pepper для HMAC-хешей токенов агентов (обязателен в production) |
| `DATABASE_URL` | PostgreSQL для основных данных |
| `DIAGRAMS_DATABASE_URL` | Таблицы карты здания (можно та же БД) |
| `WAREHOUSE_DATABASE_URL` | Склад (можно та же БД) |
| `POSTGRES_ADMIN_PASSWORD` | Пароль `postgres` для первичного создания БД |
| `BOOTSTRAP_ADMIN_*` | Первый администратор при пустой БД |

Полный список переменных — в разделе [Конфигурация](#конфигурация).

**Не коммитьте** `backend/.env` в Git.

---

### Шаг 5. Первый запуск (development)

#### Вариант A — один клик (Windows)

```powershell
.\start_all.bat
```

Батник выполняет:

1. `pip install -r backend\requirements.txt`
2. `npm install`
3. Создаёт `backend\.env`, если файла нет
4. Запускает PostgreSQL (`ensure_postgres.py`)
5. Освобождает порты 3000 и 3001
6. Стартует API (`run.py` → порт **3001**) и Vite (**3000**)

#### Вариант B — кроссплатформенный Python

```powershell
python start_all.py
python start_all.py --skip-install    # без переустановки зависимостей
python start_all.py --browser         # открыть браузер
python start_all.py --no-kill-ports   # не убивать процессы на портах
```

#### Вариант C — вручную (для разработчиков)

```powershell
python -m pip install -r backend\requirements.txt
npm install
python scripts\ensure_postgres.py
npm start
```

Отдельно:

```powershell
python run.py                              # только API :3001
npm run dev --prefix frontend              # только UI :3000
```

---

### Шаг 6. Проверка после установки

| Проверка | URL / команда | Ожидание |
|----------|---------------|----------|
| Health API | http://127.0.0.1:3001/api/v1/health | `{"status":"ok",...}` |
| Веб-панель | http://127.0.0.1:3000/ | Страница входа |
| Swagger | http://127.0.0.1:3001/docs | OpenAPI (в dev) |
| Вход | логин `admin`, пароль из `BOOTSTRAP_ADMIN_PASSWORD` | Дашборд |

```powershell
curl http://127.0.0.1:3001/api/v1/health
```

При первом входе смените пароль администратора.

---

### Шаг 7. Службы Windows и сеть (LAN)

#### Firewall на сервере CORAX

Откройте входящие порты для агентов и браузеров в LAN (от **администратора**):

```powershell
backend\open_firewall_port.bat
```

Правила: TCP **3000** (веб), TCP **3001** (API / агенты в dev).

В production (один порт) достаточно **3000** или **80/443** через reverse proxy.

#### PostgreSQL — автозапуск

```powershell
Set-Service postgresql-x64-16 -StartupType Automatic
```

#### CORAX API — автозапуск (опционально)

Через **Планировщик заданий Windows**:

1. Триггер: при входе в систему или при старте ОС.
2. Действие: `python C:\path\to\Corax\run.py`
3. Переменные: `ENVIRONMENT=production`, `PORT=3000`, `RELOAD=0`
4. Рабочая папка: корень репозитория.

Или используйте [NSSM](https://nssm.cc/) для установки `run.py` как службы Windows.

#### Linux — systemd (кратко)

Готовые unit-файлы: `deploy/corax-backend.service`, `deploy/corax-frontend.service`.
**Полная установка Ubuntu/Debian с нуля** (пакеты, PostgreSQL, пользователь, firewall, cron) —
в разделе [Linux: установка с нуля, systemd, cron](#linux-установка-с-нуля-systemd-cron).

Рекомендуемый путь — **Docker Compose** ([deploy/DOCKER.md](deploy/DOCKER.md)); ниже — опциональный systemd.

Рекомендуемый production: **один** процесс `corax-backend` на порту **3000** (UI из `frontend/dist` + API).

---

### Шаг 8. Развёртывание агентов на рабочих ПК

Эндпоинт приёма отчётов (тот же хост/порт, что у панели в Docker/production):

```http
POST /api/v1/agent/inventory
Authorization: Bearer <agent-token>
Content-Type: application/json
```

**Важно:** веб и агенты в Docker/production используют порт **3000**.  
URL агента: `http://<LAN-IP-сервера>:3000` (не `127.0.0.1`, не порт 3001).

#### Через веб-панель (рекомендуется)

**Настройки → Сборка агента** (`/settings/agent-bundle`):

| Формат | Платформа | Описание |
|--------|-----------|----------|
| **ZIP** | Win10/11 | PowerShell v3 — полный сбор |
| **ZIP** | Win7 | Базовый PowerShell-агент |

1. Откройте панель по LAN (`http://192.168.x.x:3000`) — IP и порт **подставятся сами**.
2. Либо задайте `CORAX_ADVERTISE_HOST` в `backend/.env` и перезапустите.
3. Скачайте ZIP, раздайте на ПК (шара, GPO, флешка).
4. Токен создаётся при каждой сборке — **Настройки → Токены агентов**.

Проверка с другой машины до раздачи агентов:

```bash
curl -fsS http://<LAN-IP>:3000/api/v1/health
```

#### Ручная настройка (dev)

```powershell
python tools\setup_agent_env.py --server http://192.168.1.10:3000
```

---

### Шаг 9. Production-запуск (дом / офис / LAN)

1. Скопируйте и настройте `backend/.env` для production (см. [чеклист](#production-checklist)).
2. Соберите frontend:

```powershell
npm run build
```

3. Запустите один процесс (UI + API на порту 3000):

```powershell
$env:ENVIRONMENT="production"
$env:PORT="3000"
$env:HOST="0.0.0.0"
$env:RELOAD="0"
python run.py
```

Или:

```powershell
npm run start:prod
```

Адреса:

- UI: `http://<IP-сервера>:3000/`
- API: `http://<IP-сервера>:3000/api/v1/...`
- Health: `http://<IP-сервера>:3000/api/v1/health`

Рекомендации:

- Сильные `SECRET_KEY`, `AGENT_TOKEN_PEPPER`, пароль bootstrap.
- `CORS_ORIGINS` с реальным URL панели.
- HTTPS через Caddy/Nginx + заголовок `X-Forwarded-Proto: https`.
- Регулярный бэкап: `pg_dump -Fc -U inventory inventory > backup.dump`.
- Токены агентов только через UI, не дефолтный `AGENT_TOKEN`.

---

### Шаг 10. Опциональные компоненты

#### LibreOffice (карта здания, Visio)

Windows — установите [LibreOffice](https://www.libreoffice.org/), в `.env`:

```env
SOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe
```

Linux:

```bash
sudo apt install libreoffice
# SOFFICE_PATH=/usr/bin/soffice
```

#### LM Studio (WikiRAG)

1. Установите [LM Studio](https://lmstudio.ai/).
2. Запустите Local Server (порт 1234).
3. В `.env` при необходимости:

```env
LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
LM_STUDIO_MODEL=google/gemma-3-1b
```

#### Миграция со старых SQLite-файлов

Если в `backend/` остались `inventory.db`, `diagrams.db`, `warehouse.db`:

```powershell
python scripts\migrate_sqlite_to_postgres.py
```

После проверки данных в панели архивируйте и удалите `.db` — приложение их больше не использует.

---

### Шаг 11. Типичные проблемы

| Симптом | Решение |
|---------|---------|
| `[db] ОШИБКА: PostgreSQL` | Проверьте службу, `POSTGRES_ADMIN_PASSWORD`, запустите `start_all.bat` от администратора |
| Порт 3000/3001 занят | Закройте старый процесс или `start_all.py --no-kill-ports` и смените порт |
| Агент не достучится до сервера | LAN IP (не localhost), firewall TCP **3000**, URL `http://IP:3000` |
| `Method Not Allowed` при сборке агента | API не запущен — перезапустите стек |
| Production не стартует | Задайте уникальные секреты и `AGENT_TOKEN_PEPPER` в `.env` |

---

## Быстрый старт (кратко)

Если всё уже установлено:

```powershell
.\start_all.bat
```

Откройте http://127.0.0.1:3000/ , войдите как `admin`.

---

## Архитектура

Проект разделён на четыре основных слоя:

- `backend/` — API, авторизация, модели данных, миграции PostgreSQL, интеграции, импорт/экспорт и раздача собранного фронтенда в production-режиме.
- `frontend/` — SPA-интерфейс администратора/оператора: страницы, API-клиент, навигация, таблицы, графики и карта здания.
- `agent/` — клиенты инвентаризации (ZIP PowerShell).
- Корень репозитория — скрипты запуска, `ensure_postgres.py`, e2e-тесты, документация.

Режимы:

| Режим | UI | API |
|-------|-----|-----|
| Development | `http://127.0.0.1:3000/` (Vite) | `http://127.0.0.1:3001/` (прокси `/api`) |
| Production | `http://<server>:3000/` | тот же хост, префикс `/api/v1` |

## Структура репозитория

| Путь | Назначение |
|------|------------|
| `backend/app/main.py` | FastAPI, middleware, lifecycle, миграции |
| `backend/app/config.py` | Настройки из `.env`, production-проверки |
| `backend/app/database.py` | PostgreSQL, async SQLAlchemy |
| `backend/app/models.py` | ORM-модели |
| `backend/app/routers/` | API по доменам |
| `backend/requirements.txt` | Python-зависимости |
| `backend/.env.example` | Шаблон конфигурации |
| `frontend/src/` | React SPA |
| `agent/v3/win10/` | PowerShell-агент v3 (ZIP) |
| `agent/win7/` | PowerShell-агент Win7 (ZIP) |
| `scripts/ensure_postgres.py` | Служба PG + создание БД |
| `scripts/migrate_sqlite_to_postgres.py` | Перенос из SQLite |
| `run.py`, `start_all.bat`, `start_all.py` | Запуск |
| `АРХИТЕКТУРА_ПРОЕКТА.md` | Краткая карта для разработчиков |

Подробная установка — в разделе [Полная инструкция по установке](#полная-инструкция-по-установке).

## Конфигурация

Backend читает настройки из `backend/.env`. Шаблон находится в `backend/.env.example`.

Ключевые переменные:

- `ENVIRONMENT` — `development` или `production`. В production включается проверка секретов.
- `SECRET_KEY` — ключ подписи JWT. В production должен быть уникальным и длинным.
- `DATABASE_URL` — основная PostgreSQL-БД. По умолчанию `postgresql+asyncpg://inventory:inventory@localhost:5432/inventory`.
- `DIAGRAMS_DATABASE_URL` — схемы/карта (можно та же БД).
- `WAREHOUSE_DATABASE_URL` — склад (можно та же БД).
- `CORS_ORIGINS` — разрешённые origins для браузера.
- `BOOTSTRAP_ADMIN_USERNAME` и `BOOTSTRAP_ADMIN_PASSWORD` — первый администратор при пустой БД.
- `AGENT_TOKEN` — legacy-токен агентов.
- `AGENT_TOKEN_PEPPER` — серверный pepper для HMAC-хешей новых токенов агентов. Обязателен в production.
- `AGENT_LEGACY_TOKENS` — временные старые токены через запятую на период миграции.
- `AGENT_INBOX_DIR` — директория для сырых JSON-отчётов агента. Пустое значение отключает запись.
- `AGENT_INBOX_RETENTION_DAYS` — сколько дней хранить raw payload.
- `MAX_AGENT_PAYLOAD_BYTES` — лимит размера payload агента.
- `RATE_LIMIT_LOGIN` — лимит slowapi для входа (по умолчанию `10/minute`).
- `RATE_LIMIT_AGENT` — лимит slowapi для `POST /agent/inventory` (по умолчанию `120/minute`).
- `ALLOW_DEV_ANY_AGENT_TOKEN` — в development принимать любой Bearer на агенте (по умолчанию `false`).
- `ENABLE_OPENAPI` — в production включить `/docs` (по умолчанию `false`).
- `LDAP_URI`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`, `LDAP_USER_SEARCH_BASE`, `LDAP_USER_FILTER`, `LDAP_USERNAME_ATTR`, `LDAP_DISPLAY_NAME_ATTR`, `LDAP_EMAIL_ATTR`, `LDAP_SYNC_LIMIT` — LDAP-настройки.
- `BITRIX24_WEBHOOK_URL` и `BITRIX24_IMPORT_LIMIT` — импорт пользователей Bitrix24.
- `BITRIX24_BOT_WEBHOOK_URL`, `BITRIX24_BOT_ID`, `BITRIX24_BOT_CLIENT_ID`, `BITRIX24_BOT_HANDLER_TOKEN`, `BITRIX24_BOT_INBOX_DIR` — bot-интеграция Bitrix24.
- `SOFFICE_PATH` — путь к LibreOffice `soffice` для конвертации Visio/экспорта.
- `WIKI_RAG_DIR` — каталог загруженных файлов базы знаний (по умолчанию `wiki_rag_docs`).
- `LM_STUDIO_BASE_URL`, `LM_STUDIO_MODEL` — WikiRAG, локальный OpenAI-совместимый API.
- `POSTGRES_ADMIN_USER`, `POSTGRES_ADMIN_PASSWORD` — суперпользователь PostgreSQL для `ensure_postgres.py`.

Никогда не коммитьте `backend/.env`. В репозиторий должен попадать только `backend/.env.example`.

## Пользователи, роли и безопасность

При первом запуске на пустой БД создаётся bootstrap-admin из `BOOTSTRAP_ADMIN_USERNAME` и `BOOTSTRAP_ADMIN_PASSWORD`. После первого входа пароль нужно сменить, а в production лучше отключить bootstrap через пустые значения или хранить секреты в защищённом хранилище.

Роли:

- `admin`/`is_superuser` — полный доступ: пользователи, LDAP, Bitrix24, токены агентов, настройки.
- `editor` — рабочий доступ на изменение данных, где это разрешено бизнес-логикой.
- `observer` — просмотр без административных и редакторских операций.

Авторизация:

- UI использует cookie `access_token` и `csrf_token`.
- API также поддерживает Bearer JWT для совместимости.
- Для unsafe-методов (`POST`, `PUT`, `PATCH`, `DELETE`) включена CSRF-проверка для cookie-based auth.
- Bearer-токены агентов освобождены от CSRF, так как это машинный API.

Production-режим откажется стартовать, если оставлены дефолтные значения `SECRET_KEY`, `AGENT_TOKEN`, `BOOTSTRAP_ADMIN_PASSWORD` или не задан `AGENT_TOKEN_PEPPER`.

## Основные backend-модули

- `auth` — логин, JSON-login, текущий пользователь, logout.
- `users` — пользователи, роли, права администратора, смена пароля, LDAP-sync.
- `settings` — LDAP и Bitrix24 настройки.
- `agent` — приём инвентаризации от агентов.
- `agent_tokens` — выпуск и отзыв токенов агентов.
- `computers` — парк ПК, детали, редактирование, история, CSV-экспорт/импорт GLPI PCs.
- `monitors` — импорт мониторов из GLPI CSV и привязка к пользователям.
- `dashboard` — агрегаты для дашборда и каталог ПО/хостов.
- `tags` — справочник тегов.
- `service_requests` — заявки, шаблоны, GLPI CSV, PDF.
- `diagrams` — карта здания, этажи, импорт/экспорт, bindings, WebSocket.
- `bitrix24` — импорт пользователей Bitrix24.
- `bitrix24_incoming` и `bitrix24_bot_handler` — входящие Bitrix24 события и bot-сценарии.

API подключается с двумя префиксами для совместимости:

- `/api/v1/...`
- `/api/...`

Новые интеграции лучше писать на `/api/v1`.

## Frontend-модули

Основные маршруты:

- `/` — дашборд.
- `/software` — каталог ПО.
- `/computers` — парк ПК.
- `/settings/tags` — теги.
- `/requests` — создание заявки.
- `/requests/database` — база заявок.
- `/requests/templates` — шаблоны заявок.
- `/requests/stats` — статистика заявок.
- `/knowledge-base/sitemap` — карта здания.
- `/users` — пользователи.
- `/settings/ldap` — LDAP.
- `/settings/bitrix24` — Bitrix24.
- `/settings/agent-tokens` — токены агентов.
- `/settings/agent-bundle` — сборка ZIP-агентов.

Общий API-клиент находится в `frontend/src/api.ts`, маршрутизация в `frontend/src/App.tsx`, боковое меню в `frontend/src/pages/Layout.tsx`.

## Агент инвентаризации

Сервер принимает отчёты на:

```text
POST /api/v1/agent/inventory
Authorization: Bearer <agent-token>
Content-Type: application/json
```

Payload включает:

- `hostname`;
- `serial_number`;
- `mac_primary`;
- `cpu`;
- `ram_gb`;
- `os_name` и `os_version`;
- `manufacturer` и `model`;
- `location`;
- `gpu_name`;
- `memory_used_percent`;
- `motherboard_manufacturer` и `motherboard_product`;
- `disks`;
- `software`;
- `peripherals`.

Приём отчёта идемпотентен по `hostname` без учёта регистра: существующий компьютер обновляется, новый hostname создаёт новую запись. Списки ПО и периферии заменяются свежим снимком.

Варианты агента:

| Способ | Где | Платформа |
|--------|-----|-----------|
| **ZIP v3** | Настройки → Сборка агента | Win10/11 |
| **ZIP Win7** | То же | Windows 7 |
| `tools/setup_agent_env.py` | Ручная генерация `agent_env.bat` | Win |

Для рабочих станций в LAN откройте **TCP 3000** на сервере (`backend/open_firewall_port.bat` или UFW на Linux).

Токены:

- В development для стенда можно включить приём любого Bearer-токена агента: **`ALLOW_DEV_ANY_AGENT_TOKEN=true`** в `.env` (по умолчанию выключено).
- В production используйте раздел «Токены агентов».
- Новый токен показывается один раз при создании.
- В БД хранится HMAC-хеш секрета, а не сам токен.
- Токен можно ограничить конкретным hostname.

## Заявки и GLPI

Модуль заявок поддерживает:

- ручное создание заявок;
- статусы `open`, `in_progress`, `done`;
- приоритеты `low`, `normal`, `high`;
- привязку к компьютеру;
- нескольких ответственных пользователей;
- шаблоны заявок;
- массовое удаление;
- импорт GLPI CSV;
- экспорт GLPI-compatible CSV;
- экспорт PDF.

Импорт GLPI ожидает русскоязычные заголовки вроде `ID`, `Заголовок`, `Статус`, `Последнее изменение`, `Дата открытия`, `Приоритет`, `Категория`.

## Карта здания

Раздел «Карта здания» хранится в PostgreSQL (таблицы `diagrams`, `diagram_bindings`) и поддерживает:

- создание пустого этажа;
- импорт фонового PNG;
- замену PNG-фона;
- layout кабинетов и объектов;
- привязки объектов к тегам, пользователям, компьютерам, мониторам и заявкам;
- экспорт одного этажа или всех этажей в JSON;
- экспорт SVG, PNG и PDF;
- WebSocket для совместного редактирования.

Для экспорта PDF/PNG через LibreOffice (опционально):

- Windows: укажите `SOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe`.
- Linux: обычно `SOFFICE_PATH=/usr/bin/soffice`.
- В Docker-образе Cairo уже есть; LibreOffice для Visio не требуется (импорт Visio отключён).

## LDAP

LDAP можно настроить через UI (`/settings/ldap`) или `.env`.

Поддерживается:

- bind через сервисную учётку или anonymous bind;
- поиск пользователей по `LDAP_USER_SEARCH_BASE` и `LDAP_USER_FILTER`;
- настройка атрибутов логина, ФИО и email;
- тест подключения;
- синхронизация пользователей в справочник заявок (роль `directory`, вход в панель недоступен);
- вход в панель — только локальные учётные записи CORAX (пароль в БД).

LDAP-пользователи попадают в общую таблицу пользователей и могут назначаться ответственными. Логины уникальны, поэтому локальный пользователь и LDAP-пользователь с одинаковым `username` одновременно существовать не могут.

## Bitrix24

Поддерживаются два сценария:

1. Импорт пользователей через `BITRIX24_WEBHOOK_URL`. Backend вызывает `user.get`, создаёт или обновляет локальные записи пользователей.
2. Входящие заявки через `/api/v1/integrations/bitrix24/incoming`. Endpoint защищён секретом из настроек Bitrix24-интеграции и создаёт локальную заявку от пользователя `bitrix-bot`.

Для bot-сценариев используются переменные `BITRIX24_BOT_*` и отдельная папка inbox для диагностических payload.

## База данных и хранение данных

Используется **PostgreSQL** (одна БД `inventory` для inventory, diagrams и warehouse по умолчанию):

- пользователи, ПК, ПО, периферия, мониторы, заявки, теги, токены, настройки;
- планы этажей, layout и bindings;
- склад: помещения, позиции, движения.

Миграции применяются при старте через `backend/app/migrations.py`.

Перенос со старых SQLite-файлов (`inventory.db`, `diagrams.db`, `warehouse.db`):

```bash
python scripts/migrate_sqlite_to_postgres.py
```

`run.py` и `ensure_postgres.py` могут запустить миграцию автоматически, если в PG пусто, а `.db` ещё есть.

Дополнительно на диске (не в БД):

- `backend/agent_inbox/` — raw JSON payload агентов, если включено;
- `backend/bitrix_bot_inbox/` — диагностика Bitrix24 bot;
- `backend/wiki_rag_docs/` — загруженные файлы базы знаний.

Для production:

- делайте регулярные бэкапы (`pg_dump -Fc inventory > backup.dump`);
- храните бэкапы отдельно от сервера;
- после успешной миграции старые `.db` можно архивировать и удалить (см. ниже).

## Observability (логи)

Логи пишутся **сразу в два места** (оба включаются по умолчанию):

| Куда | Зачем | Как смотреть |
|------|--------|--------------|
| **stdout** | Docker / systemd / CI | `npm run docker:logs` или journalctl |
| **Файлы** | Долгое хранение, grep без контейнера | `LOG_DIR/corax.jsonl` + `LOG_DIR/corax.log` |

Пути:

| Режим | `LOG_DIR` |
|-------|-----------|
| Local (`npm start`) | `backend/logs/` |
| Docker | `/data/logs` (volume `corax_data`) |

Формат:

- `corax.jsonl` — одна JSON-строка на событие (`ts`, `level`, `logger`, `msg`, `request_id`, …) — удобно для Loki/ELK позже.
- `corax.log` — человекочитаемый companion.
- stdout в **production** — JSON; в **development** — human (переключается `LOG_JSON`).

Каждый HTTP-ответ несёт заголовок **`X-Request-Id`** (можно прислать свой). Тот же id попадает в access-лог и в тело 500 при внутренней ошибке.

Ротация: `LOG_MAX_BYTES` (по умолчанию 10 МБ) × `LOG_BACKUP_COUNT` (14). В `ENVIRONMENT=test` файлы не пишутся.

Пример строки access-лога:

```json
{"ts":"2026-07-21T15:00:00.000Z","level":"INFO","logger":"corax","msg":"request","request_id":"a1b2…","method":"GET","path":"/api/v1/computers","status":200,"duration_ms":12.4}
```

## Тесты и проверки

Статус последней сборки — бейдж **CI** в шапке README. Подробный гайд для разработчиков: [CONTRIBUTING.md](CONTRIBUTING.md).

Доступные npm-скрипты:

```bash
npm run test:backend
npm run test:frontend
npm run test:e2e
npm run test:all
```

Сборка frontend:

```bash
npm run build
```

Backend-only:

```bash
python -m pytest -q
```

E2E-тесты находятся в `e2e/` и запускаются Playwright. Конфигурация — `playwright.config.ts`.

## Production checklist

Перед выпуском в production:

- [ ] `ENVIRONMENT=production` в `backend/.env`
- [ ] Уникальные `SECRET_KEY` (≥32 символов), `AGENT_TOKEN_PEPPER`, `BOOTSTRAP_ADMIN_PASSWORD` (≥12)
- [ ] `DATABASE_URL` и связанные URL указывают на PostgreSQL с **не дефолтным** паролем
- [ ] `backend/.env` не в Git
- [ ] `CORS_ORIGINS` под реальный URL панели
- [ ] `ALLOW_LEGACY_AGENT_TOKEN_HASHES=false` (дефолт); при миграции временно `true`
- [ ] Security headers включены (`SECURITY_HEADERS_ENABLED`, CSP в production)
- [ ] Логи: `LOG_DIR` доступен на запись; ротация и место на диске проверены
- [ ] PostgreSQL: служба в автозапуске, бэкап `pg_dump` (или Docker `db-backup`)
- [ ] HTTPS (reverse proxy) или доступ только из LAN; `X-Forwarded-Proto` за proxy
- [ ] Firewall: только нужные порты
- [ ] Токены агентов через UI; shared `AGENT_TOKEN` по возможности заменён
- [ ] `npm run build`, healthcheck `/api/v1/health/ready`
- [ ] Проверка: вход, заявка, отчёт агента, карта здания
- [ ] LibreOffice — если нужен Visio

## Linux: установка с нуля, systemd, cron

**Руководство по развёртыванию CORAX на Linux** (Ubuntu 22.04 / 24.04 LTS, Debian 12 и совместимые).  
Для новых серверов предпочтителен **Docker** ([deploy/DOCKER.md](deploy/DOCKER.md)). Опционально без контейнеров:

### Системные требования

| Компонент | Требование |
|-----------|------------|
| ОС | Linux (рекомендуется Ubuntu 22.04/24.04 или Debian 12) |
| СУБД | PostgreSQL **15+** (на практике 16 из репозитория дистрибутива) |
| Backend | Python **3.12+**, `venv` |
| Frontend | Node.js **18+** (рекомендуется **20 LTS** через NodeSource) |
| Сборка / PDF карт | Git; системные библиотеки **Cairo/Pango** (`cairosvg`); опционально LibreOffice |
| Автозапуск | systemd |
| Обновления | `update.sh` + cron |

### Целевая схема (рекомендуется)

| Компонент | Как работает |
|-----------|----------------|
| PostgreSQL | служба `postgresql` |
| CORAX | **один** процесс `corax-backend` на **:3000** (UI из `frontend/dist` + API `/api/v1`) |
| Обновления | `update.sh` + cron в 04:00 |

Пути по умолчанию: `/opt/corax`, venv **`/opt/corax/.venv`** (в корне репо, не в `backend/`), пользователь ОС **`corax`**.

> **Не копируйте «dev-схемы» в production:** не ставьте `--reload` в systemd, не поднимайте отдельно `uvicorn :3001` + `npm run preview :3000` без нужды, не делайте `git reset --hard` в cron (в репозитории — безопасный `git pull --ff-only` в `update.sh`). Unit-файлы берите из `deploy/`, а не собирайте вручную с нуля.

### Файлы в репозитории

| Файл | На сервере | Назначение |
|------|------------|------------|
| `deploy/corax-backend.service` | `/etc/systemd/system/corax-backend.service` | FastAPI + UI (`run.py`, порт 3000) |
| `deploy/corax-frontend.service` | `/etc/systemd/system/corax-frontend.service` | Опционально: split UI на :3000 |
| `update.sh` | `/opt/corax/update.sh` | `git pull --ff-only` → pip/npm → build → restart → healthcheck |
| `deploy/README.md` | — | краткая шпаргалка по unit-файлам |

---

### A. Пакеты и пользователь

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y \
  git curl ca-certificates build-essential \
  python3 python3-venv python3-pip \
  postgresql postgresql-contrib postgresql-client \
  libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
  ufw

# Node.js 20 LTS (NodeSource) — пакетный nodejs из Ubuntu часто устаревший
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node --version   # v20.x
python3 --version
psql --version
```

> `libcairo2` / Pango нужны для экспорта карт SVG→PNG/PDF (`cairosvg`). Без них pip-пакет может встать, а экспорт в панели — нет.

Пользователь и каталог:

```bash
sudo adduser --system --group --home /opt/corax --shell /bin/bash corax
sudo mkdir -p /opt/corax
sudo chown corax:corax /opt/corax
```

Клон репозитория:

```bash
sudo -u corax -H git clone https://github.com/TimaPelmesh/Corax.git /opt/corax
# или, если каталог не пустой:
# sudo -u corax -H bash -lc 'cd /opt/corax && git init && git remote add origin … && git pull origin main'
```

Если обновления/`update.sh` будут идти от **root** (cron), один раз разрешите Git для каталога (иначе `fatal: detected dubious ownership`):

```bash
sudo git config --global --add safe.directory /opt/corax
```

---

### B. PostgreSQL: роль и база `inventory`

На Linux удобнее создать БД через peer-auth (`sudo -u postgres`):

```bash
sudo -u postgres psql <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'inventory') THEN
    CREATE ROLE inventory LOGIN PASSWORD 'your_secure_password';
  END IF;
END$$;
SELECT 'CREATE DATABASE inventory OWNER inventory'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'inventory')\gexec
GRANT ALL PRIVILEGES ON DATABASE inventory TO inventory;
SQL
```

> Замените `your_secure_password` на сильный пароль и пропишите его в `DATABASE_URL`. Для быстрой лаборатории допустим временный пароль `inventory` — в production не оставляйте.

Проверка:

```bash
psql "postgresql://inventory:your_secure_password@127.0.0.1:5432/inventory" -c "SELECT 1"
```

Если пароль отклоняется — в `/etc/postgresql/*/main/pg_hba.conf` для localhost нужна `md5`/`scram-sha-256`, затем `sudo systemctl reload postgresql`.

Альтернатива: `POSTGRES_ADMIN_PASSWORD` в `backend/.env` и один раз `python scripts/ensure_postgres.py`.

---

### C. Python venv, `.env`, сборка UI

```bash
sudo -u corax -H bash -lc '
  cd /opt/corax
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r backend/requirements.txt
  cp backend/.env.example backend/.env
'
sudo -u corax nano /opt/corax/backend/.env
```

Минимум в `backend/.env` для Linux production:

```env
ENVIRONMENT=production
SECRET_KEY=<openssl rand -hex 32>
AGENT_TOKEN=<длинная случайная строка>
AGENT_TOKEN_PEPPER=<openssl rand -hex 32>
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=<пароль ≥12 символов>
DATABASE_URL=postgresql+asyncpg://inventory:your_secure_password@127.0.0.1:5432/inventory
DIAGRAMS_DATABASE_URL=postgresql+asyncpg://inventory:your_secure_password@127.0.0.1:5432/inventory
WAREHOUSE_DATABASE_URL=postgresql+asyncpg://inventory:your_secure_password@127.0.0.1:5432/inventory
CORS_ORIGINS=http://IP_СЕРВЕРА:3000,http://127.0.0.1:3000
# PG_BIN_DIR=/usr/lib/postgresql/16/bin
# SOFFICE_PATH=/usr/bin/soffice
```

```bash
openssl rand -hex 32
```

Сборка frontend (обязательно до старта `corax-backend` на :3000):

```bash
sudo -u corax -H bash -lc '
  cd /opt/corax
  npm install
  npm run build
  test -f frontend/dist/index.html && echo "UI build OK"
'
```

Пробный запуск до systemd:

```bash
sudo -u corax -H bash -lc '
  cd /opt/corax
  ENVIRONMENT=production HOST=0.0.0.0 PORT=3000 RELOAD=0 \
    .venv/bin/python run.py
'
# в другом терминале: curl -sS http://127.0.0.1:3000/api/v1/health
```

---

### D. systemd: `corax-backend`

Unit в репозитории: `deploy/corax-backend.service`  
(`User=corax`, `PORT=3000`, `RELOAD=0`, `ExecStart=/opt/corax/.venv/bin/python3 /opt/corax/run.py`).

```bash
sudo cp /opt/corax/deploy/corax-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now corax-backend
sudo systemctl status corax-backend --no-pager
curl -sS http://127.0.0.1:3000/api/v1/health
journalctl -u corax-backend -f
```

#### Опционально: `corax-frontend` (split)

Только если API специально слушает `:3001`, а UI — отдельно (`npm run preview` на `:3000`).  
В обычном production **не включайте** — достаточно одного `corax-backend`.

```bash
# только для split-режима:
sudo cp /opt/corax/deploy/corax-frontend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now corax-frontend
```

> В systemd **не** используйте `npm run dev` и **не** добавляйте `--reload` к uvicorn/`run.py`.

---

### E. Firewall (UFW)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 3000/tcp comment 'CORAX UI+API'
sudo ufw enable
sudo ufw status
```

Панель: `http://<IP>:3000/` · агенты: `http://<IP>:3000/api/v1/agent/inventory`

---

### F. `update.sh` и ночной cron

Скрипт уже в репозитории (`/opt/corax/update.sh`):  
`git fetch` + `git pull --ff-only` → `pip install -r backend/requirements.txt` → `npm install` + `npm run build` → restart `corax-backend` (и `corax-frontend`, если enabled) → healthcheck на `:3000` или `:3001`.

```bash
sudo chmod +x /opt/corax/update.sh
sudo /opt/corax/update.sh
```

Cron от **root** (ежедневно в 04:00):

```bash
sudo crontab -e
```

```cron
0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
```

Лог и live-статус:

```bash
sudo tail -n 100 /var/log/corax_update.log
sudo journalctl -u corax-backend -n 50 --no-pager
```

Если cron от пользователя `corax`, нужен NOPASSWD в `/etc/sudoers.d/corax`:

```text
corax ALL=(root) NOPASSWD: /bin/systemctl restart corax-backend.service, /bin/systemctl restart corax-frontend.service
```

---

### G. Проверка работоспособности

```bash
# порт 3000 должен слушать процесс CORAX (python / run.py)
sudo ss -tulpn | grep -E ':3000|:3001'

curl -sS http://127.0.0.1:3000/api/v1/health
sudo systemctl status corax-backend --no-pager
sudo journalctl -u corax-backend -f

# история ночных обновлений
sudo cat /var/log/corax_update.log
```

Откройте в браузере `http://<IP_сервера>:3000/` — вход bootstrap-админом из `.env`.

---

### H. Шпаргалка после clone и `.env`

```bash
cd /opt/corax
sudo -u corax python3 -m venv .venv
sudo -u corax .venv/bin/pip install -r backend/requirements.txt
sudo -u corax bash -lc 'cd /opt/corax && npm install && npm run build'
sudo cp deploy/corax-backend.service /etc/systemd/system/
sudo chmod +x update.sh
sudo git config --global --add safe.directory /opt/corax
sudo systemctl daemon-reload
sudo systemctl enable --now corax-backend
curl -sS http://127.0.0.1:3000/api/v1/health
```

---

### I. Типичные проблемы на Linux

| Симптом | Что проверить |
|---------|----------------|
| служба падает сразу | `journalctl -u corax-backend -n 50`; секреты; `ENVIRONMENT=production` без дефолтных ключей |
| нет UI | не выполнен `npm run build`; нет `frontend/dist/index.html` |
| password authentication failed | `DATABASE_URL`, `pg_hba.conf`, роль `\du` |
| порт занят | `ss -tlnp \| grep 3000` |
| агент не достучится | UFW; в сборке агента LAN IP и порт **3000** |
| `update.sh` / git pull | локальные правки — stash или commit; **не** `reset --hard` на сервере с правками `.env` |
| `fatal: detected dubious ownership` | `sudo git config --global --add safe.directory /opt/corax` |
| экспорт карты PNG/PDF падает | `apt install libcairo2 libpangocairo-1.0-0 …`; переустановка `cairosvg` в `.venv` |
| нет `pg_dump` в панели | `apt install postgresql-client`; при необходимости `PG_BIN_DIR` |

LibreOffice (Visio/доп. PDF):

```bash
sudo apt install -y libreoffice
# SOFFICE_PATH=/usr/bin/soffice
```

## Что коммитить

Коммитить нужно:

- исходники `backend/`, `frontend/`, `agent/`;
- `README.md`, `LICENSE`, `АРХИТЕКТУРА_ПРОЕКТА.md`;
- `package.json`, `package-lock.json`;
- `frontend/package.json`, `frontend/package-lock.json`;
- `backend/requirements.txt`;
- `agent/python/requirements.txt`;
- `backend/.env.example`;
- `run.py`, `start_all.py`, `start_all.bat`, `dev.bat`, `update.sh`, `deploy/`;
- `scripts/ensure_postgres.py`, `scripts/migrate_sqlite_to_postgres.py`;
- `playwright.config.ts`, `pyproject.toml`, `e2e/`;
- `.gitignore`.

Не коммитить:

- `backend/.env` и любые реальные `.env`;
- `*.db`, `*.sqlite`, `*.sqlite3`, `*.db-wal`, `*.db-shm`;
- `backend/agent_inbox/`;
- `backend/bitrix_bot_inbox/`;
- `node_modules/`, `frontend/node_modules/`;
- `frontend/dist/`;
- `.venv/`, `__pycache__/`, `.pytest_cache/`;
- реальные токены агентов, LDAP-пароли, Bitrix24 webhook URL с секретами;
- локальные cookie/log/debug-файлы.

Перед коммитом:

```bash
git status
git diff
```

Если есть сомнение, почему файл игнорируется:

```bash
git check-ignore -v <path>
```

Если секрет уже попал в публичный репозиторий, считайте его скомпрометированным: смените `SECRET_KEY`, пароли, Bitrix24 webhooks, LDAP service password и все agent tokens.

## Эксплуатация

Рекомендуемый порядок обновления:

1. Бэкап PostgreSQL: `pg_dump -Fc -U inventory inventory > backup_%date%.dump`
2. Остановить CORAX (`Ctrl+C` или `sudo systemctl stop corax-backend`)
3. Обновить код (`git pull`) **или** запустить `/opt/corax/update.sh`
4. `pip install -r backend/requirements.txt` и `npm install` при изменении зависимостей
5. `npm run build`
6. Запустить `run.py` / `sudo systemctl start corax-backend`
7. Проверить `/api/v1/health`, вход, дашборд

На Linux с systemd полная установка и ночное обновление — в [Linux: установка с нуля…](#linux-установка-с-нуля-systemd-cron).

Восстановление из бэкапа:

```powershell
pg_restore -U inventory -d inventory --clean --if-exists backup.dump
```

Healthcheck:

```bash
curl http://127.0.0.1:3001/api/v1/health
```

Ожидаемый ответ:

```json
{"status":"ok"}
```

## Лицензия

Проект распространяется под **GNU General Public License v3.0** ([LICENSE](LICENSE)).

**Автор:** Иванов Тимур · **Copyright (C) 2026 Иванов Тимур**

### Что можно делать (кратко)

| Действие | Разрешено |
|----------|-----------|
| Использовать в учёбе, лаборатории, на работе | Да |
| Менять код под себя | Да |
| Публиковать форк на GitHub | Да |
| Брать деньги за установку/поддержку | Да |
| Распространять собранный агент или сервис коллегам | Да, **но** с исходниками или офертой исходников (GPL) |

### Обязанности при распространении (важно)

Если вы **отдаёте** программу другим (архив, агент, Docker-образ, SaaS с бинарником на сервере клиента):

1. Сохраняете **ту же лицензию GPL v3**.
2. Предоставляете **исходный код** (или письменную оферту получить его) тем, кому отдали бинарник.
3. Указываете **изменения**, если вы их вносили.
4. Не снимаете копирайт и текст лицензии.

**Copyleft:** если вы распространяете **модифицированную** версию, она тоже должна быть под GPL v3 (нельзя сделать закрытый проприетарный форк и продавать без исходников).

**Внутреннее использование без передачи третьим лицам:** можно ставить в своей сети и не публиковать форки — GPL в основном срабатывает при **распространении**.

### Зависимости и совместимость

| Компонент | Лицензия (типично) | Замечание |
|-----------|-------------------|-----------|
| Ваш код CORAX | GPL-3.0 | Ваш выбор |
| FastAPI, React, PostgreSQL client и др. | MIT/BSD/Apache | Совместимы с GPL |
| **Собранный агент** (ZIP из панели) | Включает ваш GPL-код | При раздаче — оферта исходников агента |
| Bitrix24 / GLPI / LDAP | Внешние сервисы | API-интеграция не «заражает» лицензией |

Юридически точную оценку для вашей организации даёт только юрист; для учебного/личного open source GPL v3 — стандартный выбор.

### Перед публикацией на GitHub — данные

**Не коммитьте и не пушьте:**

- `backend/.env`, токены, webhook URL Bitrix24, пароли LDAP;
- дампы PostgreSQL, `*.db`, экспорты GLPI CSV с ФИО/логинами;
- `backend/agent_inbox/`, `wiki_rag_docs/` с реальными документами;
- собранные агенты с **вшитыми** токенами (токен = секрет).

Текущая проверка репозитория (исходники в Git): **корпоративных персональных данных и секретов в отслеживаемых файлах не найдено** — только примеры (`192.168.x.x`, `example.com`, плейсхолдеры в `.env.example`). Локальный `backend/.env` в `.gitignore` и в истории Git не фигурирует.

Если секрет или выгрузка инвентаризации **когда-либо** попали в публичный репозиторий — смените все ключи и токены; удаление коммита из истории не отменяет утечку.
