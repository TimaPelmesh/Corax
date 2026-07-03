# Участие в разработке CORAX

Спасибо за интерес к проекту. CORAX распространяется под [GPL-3.0](LICENSE): любые изменения, которые вы распространяете, тоже должны оставаться открытыми на тех же условиях.

Документация для администраторов и установки — в [README.md](README.md). Здесь — только то, что нужно разработчику или контрибьютору.

## Что нужно перед началом

| Компонент | Версия |
|-----------|--------|
| Python | 3.12+ (как в CI) |
| PostgreSQL | 16 (можно 14+) |
| Node.js | 20 LTS |
| Git | любой актуальный |

**Опционально для полного прогона backend-тестов экспорта карт (PNG/PDF):**

- Linux: `sudo apt install libcairo2`
- Windows: `pip install cairosvg` (обычно достаточно; при ошибках — GTK/Cairo runtime)

## Быстрый старт окружения

```bash
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax

# Backend
python -m venv .venv
# Windows:  .venv\Scripts\activate
# Linux:    source .venv/bin/activate
pip install -r backend/requirements.txt

cp backend/.env.example backend/.env
# Отредактируйте DATABASE_URL под локальный PostgreSQL

# Frontend (из корня репозитория)
npm ci
```

Создайте пустую базу PostgreSQL (имя и пользователь — как в `DATABASE_URL`), например:

```text
postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
```

Запуск для разработки (API + Vite):

```bash
npm start
```

- API: http://127.0.0.1:3001  
- Панель: http://127.0.0.1:3000  
- Документация API: http://127.0.0.1:3001/docs  

При первом старте с пустой БД создаётся админ из `BOOTSTRAP_ADMIN_*` в `.env` (по умолчанию `admin` / `admin123`).

## Тесты

CI на GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) при каждом push/PR:

1. поднимает PostgreSQL 16;
2. ставит `libcairo2` и зависимости Python;
3. запускает `pytest` для backend;
4. запускает Vitest для frontend.

Локально — те же команды, что в CI:

```bash
# Переменные (PowerShell)
$env:ENVIRONMENT="test"
$env:DATABASE_URL="postgresql+asyncpg://inventory:inventory@localhost:5432/inventory"
$env:DIAGRAMS_DATABASE_URL=$env:DATABASE_URL
$env:WAREHOUSE_DATABASE_URL=$env:DATABASE_URL

# Linux / macOS
export ENVIRONMENT=test
export DATABASE_URL=postgresql+asyncpg://inventory:inventory@localhost:5432/inventory
export DIAGRAMS_DATABASE_URL=$DATABASE_URL
export WAREHOUSE_DATABASE_URL=$DATABASE_URL
```

```bash
# Всё сразу (из корня)
npm test

# Только backend (~60+ тестов)
npm run test:backend
# или: python -m pytest -q backend/tests

# Только frontend
npm run test:frontend

# E2E (Playwright, входят в CI — нужен PostgreSQL)
npm run test:e2e
```

**Важно:** для backend-тестов нужен **живой PostgreSQL** с тем же URL, что в `DATABASE_URL`. `ENVIRONMENT=test` отключает фоновый планировщик опроса принтеров, чтобы тесты не мешали друг другу.

Перед PR убедитесь, что проходят `npm test` и `npm run test:e2e` (или минимум `npm run test:backend` и `npm run test:frontend`).

## Структура репозитория

```text
Corax/
├── backend/
│   ├── app/
│   │   ├── main.py          # FastAPI, lifespan, middleware
│   │   ├── config.py        # настройки из .env
│   │   ├── models.py        # ORM
│   │   ├── routers/         # HTTP API по доменам
│   │   └── migrations.py  # миграции схемы при старте
│   ├── tests/               # pytest (API + unit)
│   └── requirements.txt
├── frontend/
│   └── src/                 # React 19 + Vite + TypeScript
├── agent/                   # PowerShell-агенты (ZIP-сборка с сервера)
├── e2e/                     # Playwright
├── scripts/                 # утилиты (PostgreSQL, миграции)
├── run.py                   # точка входа API
└── package.json             # npm-скрипты корня
```

Основные домены API: `computers`, `service-requests`, `diagrams`, `dashboard`, `agent`, `agent-bundles`, `warehouse`, `printers`, `users`, `settings`.

## Как предложить изменение

1. **Issue** (по желанию) — опишите задачу или баг, чтобы обсудить подход до большого PR.
2. **Fork** репозитория и ветка от `main` с понятным именем (`fix/ci-badge`, `feat/warehouse-export`).
3. **Изменения** — небольшими логическими порциями; новая функциональность — с тестами, если это API или нетривиальная логика.
4. **Проверки** — `npm test` (и `npm run build` при правках frontend).
5. **Pull Request** в `main`:
   - что сделано и зачем;
   - как проверить вручную;
   - скриншот UI — если меняется интерфейс.

Мы смотрим PR по смыслу, читаемости и прохождению CI. Крупные рефакторинги лучше согласовать заранее в issue.

## Стиль кода

- Следуйте существующему стилю файла (именование, отступы, уровень комментариев).
- Минимальный diff: не смешивайте рефакторинг и фичу в одном PR.
- Секреты, `.env`, дампы БД — **не коммитить**.
- Сообщения коммитов — на русском или английском, но ясно: `fix(test): …`, `feat(settings): …`.

## Вопросы

Если что-то неясно — откройте [issue](https://github.com/TimaPelmesh/Corax/issues) с тегом `question` или опишите контекст в PR.

---

© 2026 Иванов Тимур · [GPL-3.0](LICENSE)
