# Конфигурация CORAX

Секреты — только `backend/.env` (не в git). Шаблон: `backend/.env.example`.  
Docker: `npm run docker:up` создаёт файл при отсутствии.

## Обязательное

| Переменная | Назначение |
|------------|------------|
| `ENVIRONMENT` | В контейнере всегда `production` |
| `SECRET_KEY` | Подпись JWT, ≥32 символов |
| `AGENT_TOKEN` | Legacy-токен агентов |
| `AGENT_TOKEN_PEPPER` | Pepper HMAC новых токенов |
| `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` | Первый admin **только на пустой таблице users**. Дальше пароль только в панели. |
| `DATABASE_URL` | PostgreSQL (в Docker подставляет compose) |
| `CORS_ORIGINS` | Origins панели, через запятую |
| `CORAX_ADVERTISE_HOST` | LAN-IP для сборки агентов. Как собирать и куда класть пакеты: [docs/agents.md](agents.md) |

Docker lab first-raise: admin=`admin123`, Postgres=`inventory`. После первого входа панель **требует сменить** admin-пароль.

Смена `BOOTSTRAP_ADMIN_PASSWORD` в `.env` **не** обновляет уже созданного пользователя.  
Смена `POSTGRES_PASSWORD` при живом volume ломает вход в БД — не ротировать.

## Полезное

| Переменная | Назначение |
|------------|------------|
| `CORAX_PUBLISH_PORT` | Порт панели (по умолчанию 3000) |
| `POSTGRES_PUBLISH_PORT` | По умолчанию `127.0.0.1:5433` |
| `ENABLE_OPENAPI` | `/docs` в production (по умолчанию выкл.) |
| `RATE_LIMIT_LOGIN` / `RATE_LIMIT_AGENT` | slowapi |
| `LM_STUDIO_BASE_URL` / `LM_STUDIO_DOCKER_URL` | WikiRAG |
| `LDAP_*` | Справочник (не вход в панель) |
| `BITRIX24_*` | Импорт / bot |

Полный список комментариев — в `backend/.env.example`.
