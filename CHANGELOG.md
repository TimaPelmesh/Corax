# Changelog

## 2.2.0 — 2026-07-23

### HTTPS / agents

- Три режима доступа: **HTTP (LAN)**, **HTTPS + CORAX Local CA**, **HTTPS + корпоративный CA (AD)** — `state.json` `mode`, API `/settings/tls/mode` и `/settings/tls/import`.
- Сборка агента штампует `http://` или `https://` по `agent_scheme` (не всегда HTTP).
- Баннер «нужен restart», когда конфиг и процесс не совпадают; честные подсказки про агентов и GPO.
- `install-corax-ca.bat /machine` — Trusted Root на Local Machine для парка агентов.
- Документация: EXE (C++, рекомендуется) + ZIP; CA / CORS `https://` / restart.

### Ops / Docker

- Docker healthcheck: `https://…/ready` (`curl -k`) **или** `http://…/ready` — стек не падает после включения TLS.
- `npm run start:prod` → `ENVIRONMENT=production`, `PORT=3000`, `HOST=0.0.0.0`.
- Postgres publish по умолчанию `127.0.0.1:5433` (как в `.env.example`).
- `update.sh`: health учитывает HTTPS.

### Dashboard / UX

- Метрики заявок на дашборде: всего, в работе, просрочено, среднее время закрытия.
- Общие скелетоны загрузки; более плавное переключение темы.
- Мобильная адаптация панелей/таблиц без изменения desktop-дизайна.
- Общий `PageHeader`; Settings/Computers и агентские страницы на CSS-токенах `app-*` / `--color-*`.

### Observability

- Structured logging: stdout + rotating files (`LOG_DIR/corax.jsonl`, `corax.log`); `X-Request-Id` in access logs.
- Docker: `LOG_DIR=/data/logs` in volume `corax_data`.

### Security

- Security headers middleware (nosniff, frame deny, Referrer-Policy, Permissions-Policy; CSP + HSTS in production/HTTPS).
- Login JSON: `return_token` default **false**; cookies get `Max-Age` aligned with JWT TTL.
- `ALLOW_LEGACY_AGENT_TOKEN_HASHES` default **false**.
- **slowapi**: лимиты на login и `POST /agent/inventory`.
- В **development** Bearer-токен агента «любой» только при `ALLOW_DEV_ANY_AGENT_TOKEN=true`.
- В **production** OpenAPI (`/docs`) отключён, пока не задано `ENABLE_OPENAPI=true`.

### Docs

- README / `deploy/DOCKER.md`: Docker-first, health только `:3000`/`/ready` для Docker, Visio убран из обязательного чеклиста.

### Склад (PostgreSQL)

- Таблицы склада в PostgreSQL; вкладка **«Склад»** в «Базе знаний».
- Права: просмотр — все авторизованные; редактирование — **editor** и **admin**.

### Принтеры

- Вкладка **«Принтеры»** (`/printers`): SNMP по IP, discovery, ping+SNMP, дубликаты.

---

## 2.0.0 — 2026-04-04

### Канонический API

- Канонический префикс: **`/api/v1`** (аутентификация, ПК, дашборд, теги, агент).
- Совместимость: те же маршруты продублированы под **`/api`** (без версии) для существующих скриптов.

### Данные и история

- Таблица **`asset_change_logs`**: история изменений по ПК (поля железа/ОС от агента; диффы списков ПО и периферии; ручные правки заметки, локации, закрепления, тегов).
- Поле **`computers.location`**: локация/помещение (ручной ввод в панели, не из агента).

### Панель

- Список ПК: пагинация/фильтры на стороне API (`skip`, `limit`, `q`, `tag_ids`), ответ `{ items, total }`.
- Экспорт **CSV** (`GET /api/v1/computers/export.csv`).
- Карточка ПК: блок **«История изменений»**, поле **локация**.

### Безопасность и эксплуатация

- В **`production`** при старте проверяются `SECRET_KEY`, `AGENT_TOKEN`, `AGENT_TOKEN_PEPPER`, пароль bootstrap.
- Убраны небезопасные дефолты для bootstrap: автосоздание админа только при **`BOOTSTRAP_ADMIN_USERNAME`** и **`BOOTSTRAP_ADMIN_PASSWORD`** в `.env`.
- Заголовок **`X-Request-ID`** для корреляции.

> Лимиты slowapi, отключение OpenAPI в production и `ALLOW_DEV_ANY_AGENT_TOKEN` — в релизе после 2.0.0 (см. Unreleased).

### Агент

- URL по умолчанию: **`POST /api/v1/agent/inventory`** (скрипты в репозитории обновлены).
- В схеме отчёта опционально **`schema_version`** (на будущее).

### Зависимости

- Добавлены: `httpx`, `pytest`, `pytest-asyncio`.

### Тесты

- `backend/tests/`: вход JWT, приём отчёта агента, идемпотентность по hostname.

---

## Ранее (1.x)

- Базовая панель, SQLite, JWT, агент PowerShell, теги с цветом, дашборд, каталог ПО.
