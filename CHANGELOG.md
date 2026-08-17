# Changelog

## 1.2.0 — 2026-08-18

Operational release: faster day-to-day screens, a usable Risk Center, and a cleaner Windows agent. Same Docker-first LAN install. Same bootstrap rule: `admin` / `admin123` must be changed on first login. Do not publish the panel on the internet.

### Dashboard and tickets

- Dashboard summary uses fewer COUNT queries, combined aggregates, and a 30s cache keyed by fleet/ticket stamps. Per-user notes stay uncached.
- Indexes on service-request status and close dates.
- Ticket list bulk-loads creators, PCs, and assignees instead of N+1 queries, and supports `skip` for server-side paging.

### Risk Center

- Deterministic fleet checks with optional local-AI pattern notes (counts-only payload, no hostnames).
- History of fleet health snapshots.
- Acknowledge or ignore a finding (it drops out of the score until reopened). Click a PC to open its card.

### Agents

- Windows C++ agent splash is blue/white/black only.
- Portable Windows agent delivery (signed template stays immutable; machine-bound credentials via DPAPI).

### Network

- Topology work is deferred until the map view, so the Network page opens faster.

---

## 1.1.0 — 2026-08-17

Panel polish on top of 1.0.0. Same Docker-first LAN install. Same bootstrap rule: `admin` / `admin123` must be changed on first login. Do not publish the panel on the internet.

### Versions

- Project version is **1.1.0** everywhere that used to drift: `pyproject.toml`, root `package.json`, `frontend/package.json`, README release badge.

### Warehouse

- All stock is **items** (позиции): one row and a shelf quantity — RAM, SSD, toner, cables alike. No consumables vs equipment split.
- Add quantity on a row, write-off by count, history. Filters: all / components / peripherals / network / other. Condition is new or used.
- GLPI-tolerant CSV import/export into a chosen room; Location does not create CORAX rooms. Existing rows are not moved on re-import.

### Tickets

- Denser create form (assignees + PC on one row) and compact list cards.
- Executive PDF: five A4 sheets; donut totals print as SVG text so they survive print-to-PDF.

### Network map

- Spanning-tree layout from gateways: traceroute paths among gear (violet), LLDP/CDP/FDB as the rest.
- PCs hang under the parent switch or collapse into a bubble instead of filling the canvas.

### Settings

- **AI agent:** compact LM Studio / Ollama chips. Offline “model unavailable” notices are muted gray, not yellow.
- **HTTPS:** compact HTTP / Local CA / enterprise chips; generate, trust, and PEM import show only for the selected mode.

### WikiRAG

- Library drawer is wide enough for the tree + files.
- Indexing/errors sit in a slim header/toolbar instead of stacked banners.
- Overlay is portaled above the shell so the sidebar collapse chevron does not sit on the dialog.

### Ops

- After `git pull` on a VM, force a new image if the UI looks stale: `npm run docker:rebuild` or `CORAX_FORCE_BUILD=1 ./update.sh`. Fingerprint-skip `docker:up` will keep the old `corax:local`.
- If Docker Hub returns `502` while resolving `python:3.12-slim-bookworm`, retry the build; that is registry downtime, not a CORAX bug.

---

## 1.0.0 — 2026-08-16

First public release.

CORAX is a Docker-first LAN inventory panel: Windows/Linux agents, tickets, warehouse, SNMP printers, and a network map.

### Install

- `npm run docker:up` is the only supported start command. The image rebuilds only when sources change. `pull_policy` does not pull Postgres/backup from Hub on every up.
- Bootstrap login `admin` / `admin123` must be changed before the panel API works (`403 password_change_required` otherwise).
- Optional updates: one `update.sh` (no `CORAX_DEPLOY`, no `scripts/corax-docker-update.sh`).

### Agents

- Windows ZIP copies `agent/windows` into the image (fixes “Agent template not found” in Docker).
- C++ EXE template is stamped with server URL and token from the panel.

### Panel

- Layout split (nav/shell/badges); the sidebar polls a light `/dashboard/nav-badges` endpoint.
- Warehouse lives at `/warehouse` (old `/knowledge-base/warehouse` redirects). Settings hub at `/settings`.
- Guide copy is i18n. Tickets use dedicated route components.
- Login is a light full-page screen. Page titles are not repeated as in-page heroes.
- WikiRAG is a full-tab chat (session list, conversation, library drawer) with a locked message viewport.
- Network map lays out routers, switches, and PCs from LLDP/CDP/FDB plus traceroute across neighboring `/24`s.

### Import

- Flexible PC CSV import.
- Batched GLPI / service-request CSV import with a job status API.

### HTTPS / ops (carried from pre-public builds)

- HTTP LAN, HTTPS + CORAX Local CA, or HTTPS + corporate CA.
- Docker healthcheck supports HTTP or HTTPS `/ready`.
- Postgres published at `127.0.0.1:5433` by default.
- Structured logs, security headers, slowapi limits on login and agent inventory.
- Production OpenAPI is off unless `ENABLE_OPENAPI=true`.

---

## Pre-public development notes

The items below were built before this public `v1.0.0` tag. They are kept for operators who followed earlier private builds.

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
