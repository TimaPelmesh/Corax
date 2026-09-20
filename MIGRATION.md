# Миграция на PostgreSQL и обновление 2.x

## База данных (PostgreSQL)

По умолчанию используется PostgreSQL (`DATABASE_URL`, см. `backend/.env.example`).

При **первом запуске** сервера:

1. SQLAlchemy создаёт таблицы и применяет миграции из `backend/app/migrations.py`.
2. При пустой БД и наличии старых файлов `backend/*.db` (SQLite) можно один раз перенести данные:

   ```bash
   python scripts/migrate_sqlite_to_postgres.py
   ```

**Существующие данные в PostgreSQL не удаляются** при обновлении кода.

## Резервная копия перед обновлением

1. Остановите сервер.
2. Сделайте дамп PostgreSQL:

   ```bash
   pg_dump -Fc -U inventory inventory > backup.dump
   ```

## Миграция со старых SQLite-файлов (1.x)

Если в `backend/` остались `inventory.db`, `diagrams.db`, `warehouse.db`:

```bash
python scripts/migrate_sqlite_to_postgres.py
```

После проверки данных в панели архивируйте и удалите `.db` — приложение их больше не использует.

## API клиентов

| Было (1.x) | Стало (2.0+) |
|------------|--------------|
| `POST /api/agent/inventory` | **`POST /api/v1/agent/inventory`** (рекомендуется) |
| `POST /api/auth/login/json` | **`POST /api/v1/auth/login/json`** |
| `GET /api/computers` (массив) | **`GET /api/v1/computers`** → `{ "items": [...], "total": N }` |

Старые пути под **`/api/...`** без `v1` пока **работают** (дубликат маршрутов). Новые интеграции ориентируйте на **`/api/v1`**.

## Конфигурация (.env)

1. Скопируйте `backend/.env.example` в `backend/.env`.
2. Задайте как минимум:
   - **`SECRET_KEY`** — длинная случайная строка (JWT).
   - **`AGENT_TOKEN`** / **`AGENT_TOKEN_PEPPER`** — секреты для агентов.
   - **`DATABASE_URL`** — PostgreSQL (`postgresql+asyncpg://...`).
3. Для первого администратора (пустая БД) задайте **`BOOTSTRAP_ADMIN_USERNAME`** и **`BOOTSTRAP_ADMIN_PASSWORD`**.
4. Для production установите **`ENVIRONMENT=production`**.

## Агенты на ПК

Обновите URL в скриптах / GPO / планировщике: путь **`/api/v1/agent/inventory`**. Токен в заголовке `Authorization: Bearer ...`.

В development **не** принимается произвольный Bearer-токен, пока явно не задано `ALLOW_DEV_ANY_AGENT_TOKEN=true`.

## Откат

1. Остановите сервер.
2. Восстановите дамп PostgreSQL: `pg_restore -U inventory -d inventory --clean --if-exists backup.dump`
3. При откате на код 1.x со SQLite верните старый релиз и файл `inventory.db` из резервной копии.
