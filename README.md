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
  <strong>Self-hosted LAN inventory and a light helpdesk.</strong><br/>
  Fleet, tickets, warehouse, and network map — for offices, labs, and schools.
</p>

<p align="center">
  <a href="https://github.com/TimaPelmesh/Corax/actions/workflows/ci.yml"><img src="https://github.com/TimaPelmesh/Corax/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-1f6feb?style=flat-square" alt="License GPLv3" /></a>
  <img src="https://img.shields.io/badge/target-trusted%20LAN-6e7781?style=flat-square" alt="Trusted LAN" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/FastAPI-0.115-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
</p>

---

CORAX is a panel for a **trusted local network**. Agents report PCs. The UI tracks tickets, stock, printers, and topology. Optional WikiRAG answers from your own docs. Do **not** publish the panel on the public internet.

**Run it with Docker only.** Full install: **[GETTING_STARTED.md](GETTING_STARTED.md)**. In the panel: **Knowledge base → Documentation**.

| Layer | What it does |
|------|----------------|
| Collection | Windows ZIP with CORAX-Agent.exe (tray, collect on panel request) and a Linux bash ZIP. Tokens are HMAC; the Windows agent seals the token with DPAPI. |
| Panel | Dashboard, Risk Center, computers, software, SNMP printers, network map, floor plan, warehouse, tickets, WikiRAG |
| Integrations | LDAP directory, Bitrix24, Zabbix, GLPI CSV, local LLM (Ollama / LM Studio) |

```bash
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax
npm run docker:up
```

Open `http://YOUR-LAN-IP:3000/` · first login `admin` / `admin123` — the API stays locked until you change that password.

The first image build takes a few minutes. Later `docker:up` calls skip the rebuild unless sources changed. The stack is meant to run for years without `git pull`: the image stays frozen, Postgres and files live in volumes, containers restart after a reboot. Updating from GitHub is optional (`./update.sh`).

## Reliability

- `restart: unless-stopped` — panel and Postgres come back after a host reboot.
- Data in named volumes (`corax_pgdata`, `corax_data`, `corax_backups`). `docker:down` does not delete them.
- `/api/v1/health` for liveness, `/api/v1/health/ready` for Postgres.
- Scheduled DB dumps from **Settings → Database**. Take a backup before `update.sh`.
- The UI retries idempotent GET requests on a brief network blip and shows a banner if the API is down.

## Security (LAN)

- Passwords hashed with bcrypt. Panel JWT is versioned: logout and password change revoke older sessions.
- Agent tokens stored as HMAC (pepper in `backend/.env`). A shared token cannot overwrite a PC when MAC/serial disagree.
- Rate limits on login and agent inventory. CSRF on cookie sessions. HTML notes are sanitized.
- OpenAPI docs off in production unless `ENABLE_OPENAPI=true`.
- Observer role does not receive SNMP community strings or `/h` client secrets.

Details: [SECURITY.md](SECURITY.md) · [docs/config.md](docs/config.md).

## Commands

| Command | Purpose |
|---------|---------|
| `npm run docker:up` | only supported start command (rebuilds the image only when needed) |
| `npm run docker:rebuild` | force-rebuild the image |
| `npm run docker:ps` / `logs` / `restart` / `down` | status, logs, restart, stop (volumes keep data) |
| `./update.sh` | optional `git pull` + same as `docker:up` |

For LAN agents set `CORAX_ADVERTISE_HOST` and `CORS_ORIGINS` in `backend/.env`, then `npm run docker:restart`. Build the agent from the panel on the LAN IP, not `127.0.0.1`.

Docs: [GETTING_STARTED.md](GETTING_STARTED.md) · [docs/docker.md](docs/docker.md) · [docs/agents.md](docs/agents.md) · [docs/config.md](docs/config.md) · [CHANGELOG](CHANGELOG.md) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md)

**Author:** Timur Ivanov · **License:** [GNU GPL v3](LICENSE) · © 2026
