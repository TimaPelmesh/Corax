# CORAX

[![CI](https://github.com/TimaPelmesh/Corax/actions/workflows/ci.yml/badge.svg)](https://github.com/TimaPelmesh/Corax/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Python 3.12+](https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)

**CORAX** — открытая система инвентаризации парка ПК и лёгкого helpdesk для локальной сети.

| | |
|---|---|
| **Инвентаризация** | Агенты Win10/11 (EXE и ZIP), железо, ПО, периферия |
| **Операции** | Заявки, категории, шаблоны, GLPI CSV |
| **Наглядность** | Дашборд, карта здания, склад, принтеры SNMP |
| **Стек** | FastAPI · React · PostgreSQL |

**Автор:** Иванов Тимур · **Лицензия:** [GNU GPL v3](LICENSE) · © 2026  
**Разработчикам:** [CONTRIBUTING.md](CONTRIBUTING.md)

---

CORAX принимает отчёты агентов в LAN, хранит данные в PostgreSQL и даёт веб-панель для администратора: парк ПК, заявки, пользователи, карта помещений.

### Содержание

1. [Возможности](#возможности)
2. [Стек и зависимости](#стек-и-зависимости)
3. [Полная инструкция по установке](#полная-инструкция-по-установке) — **главный раздел**
   - [Где скачать компоненты](#где-скачать-компоненты-официальные-ссылки)
   - [PostgreSQL — подробно](#шаг-1-установка-postgresql)
4. [Быстрый старт](#быстрый-старт-кратко)
5. [Архитектура и структура](#архитектура)
6. [Конфигурация](#конфигурация)
7. [Агенты, заявки, карта, LDAP, Bitrix24](#агент-инвентаризации)
8. [Тесты](#тесты-и-проверки)
9. [Production checklist](#production-checklist)
10. [Linux: установка с нуля, systemd, cron](#linux-установка-с-нуля-systemd-cron)
11. [Эксплуатация и бэкапы](#эксплуатация)

## Возможности

- Дашборд по парку ПК: количество машин, ОС, производители, модели, RAM, диски, периферия, мониторы, пользователи и заявки.
- Инвентаризация ПК через агент: hostname, серийный номер, MAC, CPU, RAM, ОС, производитель, модель, GPU, материнская плата, диски, ПО и периферия.
- Карточки компьютеров: фильтры, поиск, редактирование заметок, кабинета, ответственного, тегов и просмотр истории изменений.
- Каталог ПО: список программ и компьютеров, где они установлены.
- Теги: справочник цветных меток для группировки компьютеров.
- Заявки: создание, база заявок, статусы, приоритеты, ответственные, шаблоны, статистика, импорт/экспорт GLPI CSV и PDF-выгрузка.
- Карта здания: этажи/планы, импорт PNG и Visio через LibreOffice, расстановка объектов, привязки к компьютерам/мониторам/пользователям/заявкам, экспорт SVG/PNG/PDF/JSON.
- Совместная работа с картой через WebSocket: пользователи видят правки и перемещения объектов в реальном времени.
- Пользователи и роли: локальные учётные записи CORAX (`observer`, `editor`, `admin`); LDAP/Bitrix24 — справочник для заявок без входа в панель.
- Токены агентов: выпуск, отзыв, привязка токена к hostname, хранение токенов в виде HMAC-хеша.
- Bitrix24: импорт пользователей через REST webhook, входящие события/заявки через защищённый endpoint, базовая bot-интеграция.
- Production checks: при `ENVIRONMENT=production` приложение не стартует с дефолтными секретами.
- Сборка агентов: ZIP (PowerShell v3) и автономный **EXE** для Win10/11 из веб-панели.

## Стек и зависимости

### Системные требования

| Компонент | Минимум | Рекомендуется |
|-----------|---------|---------------|
| ОС сервера | Windows 10/11, Ubuntu 22.04+, macOS 13+ | Windows Server / Ubuntu LTS |
| Python | 3.10 | 3.12 |
| PostgreSQL | 14 | 16 |
| Node.js | 18 LTS | 20 LTS |
| RAM (сервер) | 2 ГБ | 4+ ГБ |
| Диск | 2 ГБ свободно | 10+ ГБ (БД, логи, сборка EXE) |

Опционально (по функциям):

| Компонент | Зачем |
|-----------|--------|
| LibreOffice (`soffice`) | Импорт Visio, экспорт PDF/PNG карт |
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
| pyinstaller | 6.11.1 | Сборка CORAX-Agent.exe из панели |
| psutil | 6.1.0 | Сбор данных агентом / PyInstaller |
| requests | 2.32.3 | Отправка отчётов агентом |

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
| PowerShell v3 (`agent/v3/win10`) | Максимальный сбор Win10/11 → ZIP |
| PowerShell Win7 (`agent/win7`) | Базовый сбор Win7 → ZIP |
| Python (`agent/python`) | Сбор WMI/ПО; основа для EXE |
| PyInstaller | Onefile `CORAX-Agent.exe` с GUI (tkinter) |

Порты по умолчанию:

| Порт | Служба |
|------|--------|
| 5432 | PostgreSQL |
| 3001 | FastAPI (development) |
| 3000 | Vite dev / production UI |
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
| **LibreOffice** (опционально) | 7.x+ | [libreoffice.org/download](https://www.libreoffice.org/download/download/) | Карта здания: Visio → PDF/PNG, экспорт планов |
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

Или распакуйте архив проекта в удобную папку без кириллицы в пути (для PyInstaller и npm надёжнее).

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

Для сборки EXE-агентов из панели на сервере нужны `pyinstaller`, `psutil`, `requests` — они уже в `requirements.txt`.

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

Docker в этой инструкции **не используется** — только нативный PostgreSQL + systemd.

Рекомендуемый production: **один** процесс `corax-backend` на порту **3000** (UI из `frontend/dist` + API).

---

### Шаг 8. Развёртывание агентов на рабочих ПК

Эндпоинт приёма отчётов:

```http
POST /api/v1/agent/inventory
Authorization: Bearer <agent-token>
Content-Type: application/json
```

#### Через веб-панель (рекомендуется)

**Настройки → Сборка агента** (`/settings/agent-bundle`):

| Формат | Платформа | Описание |
|--------|-----------|----------|
| **EXE** | Win10/11 | Один файл `CORAX-Agent.exe`, встроены IP сервера и токен, окно статуса. Сборка 1–3 мин на сервере. |
| **ZIP** | Win10/11 | PowerShell v3 — полный сбор (патчи, BitLocker, Office…). |
| **ZIP** | Win7 | Базовый PowerShell-агент. |

1. Укажите **LAN IP** сервера (не `127.0.0.1`).
2. Порт API: **3001** (dev) или **3000** (production с одним процессом).
3. Скачайте EXE или ZIP.
4. Раздайте на ПК (шара, GPO, флешка).
5. Токен создаётся при каждой сборке; управление — **Настройки → Токены агентов**.

Сборка EXE возможна **только на Windows-сервере** с установленным PyInstaller.

#### Ручная настройка агента

```powershell
python tools\setup_agent_env.py --server http://192.168.1.10:3001
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
| Агент не достучится до сервера | LAN IP (не localhost), firewall, порт 3001/3000 |
| EXE не собирается | Windows-сервер, `pip install pyinstaller`, подождите до 3 мин |
| `Method Not Allowed` при сборке агента | API не запущен — перезапустите `run.py` / `start_all.bat` |
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
- `agent/` — клиенты инвентаризации для рабочих станций (ZIP PowerShell, EXE Python).
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
| `backend/app/agent_exe.py` | Сборка CORAX-Agent.exe |
| `backend/requirements.txt` | Python-зависимости |
| `backend/.env.example` | Шаблон конфигурации |
| `frontend/src/` | React SPA |
| `agent/v3/win10/` | PowerShell-агент v3 (ZIP) |
| `agent/python/` | Python-агент и GUI для EXE |
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
- `/settings/agent-bundle` — сборка ZIP / EXE агентов.

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

| Способ | Файл / раздел | Платформа |
|--------|---------------|-----------|
| **EXE из панели** | Настройки → Сборка агента → EXE | Win10/11, автономный |
| **ZIP v3** | Настройки → Сборка агента → ZIP | Win10/11, полный PS-сбор |
| **ZIP Win7** | То же, платформа Win7 | Windows 7 |
| `agent/python/agent.py` | Ручной Python-агент | Win/Linux |
| `tools/setup_agent_env.py` | Генерация `agent_env.bat` | Win |

Для рабочих станций в LAN откройте входящий TCP-порт API на сервере (`backend/open_firewall_port.bat` — порты 3000 и 3001).

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
- импорт Visio с конвертацией в SVG через LibreOffice;
- layout кабинетов и объектов;
- привязки объектов к тегам, пользователям, компьютерам, мониторам и заявкам;
- экспорт одного этажа или всех этажей в JSON;
- экспорт SVG, PNG и PDF;
- WebSocket для совместного редактирования.

Для Visio/экспорта нужен LibreOffice:

- Windows: укажите `SOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.exe`.
- Linux: обычно `SOFFICE_PATH=/usr/bin/soffice`.

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
- [ ] PostgreSQL: служба в автозапуске, бэкап `pg_dump`
- [ ] HTTPS (reverse proxy) или доступ только из LAN
- [ ] Firewall: только нужные порты
- [ ] Токены агентов через UI; legacy `AGENT_TOKEN` отозван
- [ ] `npm run build`, healthcheck `/api/v1/health`
- [ ] Проверка: вход, заявка, отчёт агента, карта здания
- [ ] LibreOffice — если нужен Visio

## Linux: установка с нуля, systemd, cron

Инструкция для **Ubuntu 22.04 / 24.04** и совместимых Debian. Docker **не нужен**: PostgreSQL и CORAX ставятся нативно, автозапуск — через systemd.

Целевая схема (рекомендуется):

| Компонент | Как работает |
|-----------|----------------|
| PostgreSQL | служба `postgresql` |
| CORAX | один процесс `corax-backend` на **:3000** (UI + API после `npm run build`) |
| Обновления | `update.sh` + cron в 04:00 |

Пути по умолчанию: `/opt/corax`, venv `/opt/corax/.venv`, пользователь ОС `corax`.

### Файлы в репозитории

| Файл | На сервере | Назначение |
|------|------------|------------|
| `deploy/corax-backend.service` | `/etc/systemd/system/corax-backend.service` | FastAPI + UI (`run.py`, порт 3000) |
| `deploy/corax-frontend.service` | `/etc/systemd/system/corax-frontend.service` | Опционально: split UI на :3000 |
| `update.sh` | `/opt/corax/update.sh` | `git pull` → pip/npm → build → restart |
| `deploy/README.md` | — | краткая шпаргалка по unit-файлам |

---

### A. Пакеты и пользователь

```bash
sudo apt update
sudo apt install -y \
  git curl ca-certificates build-essential \
  python3 python3-venv python3-pip \
  postgresql postgresql-contrib postgresql-client \
  ufw

# Node.js 20 LTS (NodeSource) — нужен для сборки frontend
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node --version   # v20.x
python3 --version
psql --version
```

Пользователь и каталог:

```bash
sudo adduser --system --group --home /opt/corax --shell /bin/bash corax
sudo mkdir -p /opt/corax
sudo chown corax:corax /opt/corax
```

Клон репозитория (подставьте свой URL):

```bash
sudo -u corax -H git clone https://github.com/TimaPelmesh/Corax.git /opt/corax
# или, если каталог не пустой:
# sudo -u corax -H bash -lc 'cd /opt/corax && git init && git remote add origin … && git pull origin main'
```

---

### B. PostgreSQL: роль и база `inventory`

На Linux удобнее создать БД через peer-auth (`sudo -u postgres`):

```bash
sudo -u postgres psql <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'inventory') THEN
    CREATE ROLE inventory LOGIN PASSWORD 'inventory';
  END IF;
END$$;
SELECT 'CREATE DATABASE inventory OWNER inventory'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'inventory')\gexec
GRANT ALL PRIVILEGES ON DATABASE inventory TO inventory;
SQL
```

> В production смените пароль `inventory` на сильный и пропишите его в `DATABASE_URL`.

Проверка:

```bash
psql "postgresql://inventory:inventory@127.0.0.1:5432/inventory" -c "SELECT 1"
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
DATABASE_URL=postgresql+asyncpg://inventory:ВАШ_ПАРОЛЬ@127.0.0.1:5432/inventory
DIAGRAMS_DATABASE_URL=postgresql+asyncpg://inventory:ВАШ_ПАРОЛЬ@127.0.0.1:5432/inventory
WAREHOUSE_DATABASE_URL=postgresql+asyncpg://inventory:ВАШ_ПАРОЛЬ@127.0.0.1:5432/inventory
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

Unit в репозитории: `deploy/corax-backend.service` (`User=corax`, `PORT=3000`, `RELOAD=0`, `ExecStart=…/.venv/bin/python3 …/run.py`).

```bash
sudo cp /opt/corax/deploy/corax-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now corax-backend
sudo systemctl status corax-backend --no-pager
curl -sS http://127.0.0.1:3000/api/v1/health
journalctl -u corax-backend -f
```

#### Опционально: `corax-frontend` (split)

Только если API на `:3001`, а UI отдельно (`npm run preview`). В обычном production **не включайте**.

> В systemd **не** используйте `npm run dev`.

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

```bash
sudo chmod +x /opt/corax/update.sh
sudo /opt/corax/update.sh
```

Скрипт: `git pull` → pip → `npm install` + `npm run build` → restart служб → healthcheck.

Cron от **root**:

```bash
sudo crontab -e
```

```cron
0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
```

```bash
sudo tail -n 100 /var/log/corax_update.log
```

Если cron от `corax`, NOPASSWD в `/etc/sudoers.d/corax`:

```text
corax ALL=(root) NOPASSWD: /bin/systemctl restart corax-backend.service, /bin/systemctl restart corax-frontend.service
```

---

### G. Шпаргалка после clone и `.env`

```bash
cd /opt/corax
sudo -u corax python3 -m venv .venv
sudo -u corax .venv/bin/pip install -r backend/requirements.txt
sudo -u corax bash -lc 'cd /opt/corax && npm install && npm run build'
sudo cp deploy/corax-backend.service /etc/systemd/system/
sudo chmod +x update.sh
sudo systemctl daemon-reload
sudo systemctl enable --now corax-backend
curl -sS http://127.0.0.1:3000/api/v1/health
```

---

### H. Типичные проблемы на Linux

| Симптом | Что проверить |
|---------|----------------|
| служба падает сразу | `journalctl -u corax-backend -n 50`; секреты; production без дефолтных ключей |
| нет UI | не выполнен `npm run build`; нет `frontend/dist/index.html` |
| password authentication failed | `DATABASE_URL`, `pg_hba.conf`, роль `\du` |
| порт занят | `ss -tlnp \| grep 3000` |
| агент не достучится | UFW; в сборке агента LAN IP и порт **3000** |
| `update.sh` / git pull | локальные правки — stash или commit |
| нет `pg_dump` в панели | `apt install postgresql-client`; при необходимости `PG_BIN_DIR` |

LibreOffice (Visio/PDF карт):

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
| Распространять **собранный EXE** или сервис коллегам | Да, **но** с исходниками или офертой исходников (GPL) |

### Обязанности при распространении (важно)

Если вы **отдаёте** программу другим (архив, EXE, Docker-образ, SaaS с бинарником на сервере клиента):

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
| **Собранный CORAX-Agent.exe** (PyInstaller) | Включает ваш GPL-код | При раздаче EXE — оферта исходников агента |
| Bitrix24 / GLPI / LDAP | Внешние сервисы | API-интеграция не «заражает» лицензией |

Юридически точную оценку для вашей организации даёт только юрист; для учебного/личного open source GPL v3 — стандартный выбор.

### Перед публикацией на GitHub — данные

**Не коммитьте и не пушьте:**

- `backend/.env`, токены, webhook URL Bitrix24, пароли LDAP;
- дампы PostgreSQL, `*.db`, экспорты GLPI CSV с ФИО/логинами;
- `backend/agent_inbox/`, `wiki_rag_docs/` с реальными документами;
- собранные EXE с **вшитыми** токенами (токен = секрет).

Текущая проверка репозитория (исходники в Git): **корпоративных персональных данных и секретов в отслеживаемых файлах не найдено** — только примеры (`192.168.x.x`, `example.com`, плейсхолдеры в `.env.example`). Локальный `backend/.env` в `.gitignore` и в истории Git не фигурирует.

Если секрет или выгрузка инвентаризации **когда-либо** попали в публичный репозиторий — смените все ключи и токены; удаление коммита из истории не отменяет утечку.
