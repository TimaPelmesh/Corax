# Contributing to CORAX

License: [GPL-3.0](LICENSE). Product install: **[GETTING_STARTED.md](GETTING_STARTED.md)** (Docker only). This file is how to change code and run tests.

## Environment

You need **Docker**, **Git**, and **Node.js 20**. You do not need host PostgreSQL or a separate venv to run the panel.

```bash
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax
npm run docker:up
```

UI unit tests: `npm ci` (Playwright) and `npm ci --prefix frontend` (Vitest). That is not required to run the panel.

Panel: http://127.0.0.1:3000/  
First login `admin` / `admin123`, then change the password (skipped in pytest/e2e when `ENVIRONMENT=test`).

Stack Postgres from the host: `127.0.0.1:5433` (see `POSTGRES_PUBLISH_PORT`).

## Tests

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) uses path filters — pytest / Vitest / Playwright / Docker do not all run on every push.

Local backend tests use the same Docker Postgres:

```bash
# PowerShell
$env:ENVIRONMENT="test"
$env:DATABASE_URL="postgresql+asyncpg://inventory:inventory@127.0.0.1:5433/inventory"
$env:DIAGRAMS_DATABASE_URL=$env:DATABASE_URL
$env:WAREHOUSE_DATABASE_URL=$env:DATABASE_URL

# Linux / macOS
export ENVIRONMENT=test
export DATABASE_URL=postgresql+asyncpg://inventory:inventory@127.0.0.1:5433/inventory
export DIAGRAMS_DATABASE_URL=$DATABASE_URL
export WAREHOUSE_DATABASE_URL=$DATABASE_URL
```

```bash
npm test                 # backend + frontend
npm run test:backend     # pytest
npm run test:frontend    # vitest
npm run test:e2e         # Playwright (builds the UI and starts run.py on :3000)
```

`ENVIRONMENT=test` disables background schedulers. Map export tests: Linux `libcairo2`; Windows usually has `cairosvg`.

Before a PR: `npm test` (and `npm run test:e2e` / `npm run build` if you touched the UI).

## Layout

```text
Corax/
├── backend/app/         # FastAPI
├── frontend/src/        # React + Vite
├── agent/               # EXE / ZIP agents
├── e2e/                 # Playwright
├── docs/                # Docker, agents, .env
├── GETTING_STARTED.md   # only supported start path
├── update.sh            # optional GitHub update
└── package.json         # docker:* and tests
```

## Pull requests

Small logical chunks. No secrets, no `.env`. Clear commit messages. Large refactors: open an issue first.

© 2026 Timur Ivanov · [GPL-3.0](LICENSE)
