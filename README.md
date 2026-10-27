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
  <strong>Self-hosted operations panel for a trusted LAN.</strong><br/>
  Fleet, service desk, stock, network, and servers. For offices, labs, and schools.
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

CORAX is the panel an office, a lab, or a school runs on its own network. One install keeps the computer fleet, the service desk, the warehouse, the printers, the network map, and a live audit of Linux servers. LDAP, Bitrix24, GLPI, and Zabbix bring in the directory, the chat, an existing ticket export, and the monitoring the site already runs. WikiRAG answers from your own docs through a local LLM. On the server-audit host the same panel reads llama.cpp metrics and can start, stop, and restart only the model units. Do **not** publish the panel on the public internet.

**Run it with Docker only.** Full install: **[GETTING_STARTED.md](GETTING_STARTED.md)**. In the panel: **Knowledge base → Documentation**.

The install is one FastAPI process and one Postgres, so the next piece of site work lands in the same database and the same UI: a Bitrix24 message that becomes a ticket, a host action inside the allowlist, a chart stored as a folded series.

## What the panel covers

| Area | What it does |
|------|----------------|
| Fleet | Windows: one `CORAX-Agent.exe` (tray, collect when the panel asks). Linux: one bash ZIP and one token for every server. Tokens are HMAC; the Windows agent seals its token with DPAPI. |
| Desk | Tickets, templates, and stats. The Bitrix24 bot (`imbot.v2`) turns a chat message into a service request. |
| Site | Dashboard, Risk Center, software catalog, SNMP printers, network, network map, floor plan, warehouse. |
| Servers | Live audit: temperature, CPU, memory, disk, load, network, journal, sensors. **Manage** is a short allowlist, described below. LLM nodes on that host expose GPU rows, llama.cpp token rates, and restarts limited to `llama-server` and `rpc-server-gpu0`…`gpu7`. |
| Knowledge | Documentation, notes, WikiRAG, Zabbix problems. |
| Access | Local users and LDAP. Observers do not see job output or SNMP secrets. Role `llm-operator` opens server audit only. |

## Where it is going

CORAX is the system of record for a site that wants this work in one place, on hardware it controls, for years.

- **Fleet and desk stay the core.** Stock, topology, and risk hang off the same computers and the same tickets.
- **Chat is a door into the desk.** Bitrix24 already turns a message into a request. The panel stays the record. Another messenger, when it comes, should arrive the same way: one webhook, one ticket.
- **The hand on a server stays short.** Audit can check, read, restart, and write only inside the allowlist. Further operations join that list. A shell stays outside the product.
- **The model stays on the LAN.** Answers come from the site's own text. Cluster health sits on the audit screen of the machine that runs the model.
- **The box outlives the release.** Named volumes keep Postgres and files. Updates from GitHub are optional. A site can freeze an image and run it until it chooses the next one.

## Stack

One command starts the whole product: `npm run docker:up`. There is no second API process, no Redis, and no microservice split.

| Piece | Role |
|------|------|
| FastAPI, one Uvicorn process | Panel API, agent ingest, audit jobs |
| PostgreSQL 16 (pgvector image) | Inventory, tickets, audit samples, WikiRAG vectors |
| React 19, Vite, TypeScript | The panel |
| Docker Compose | `db`, `app`, `db-backup` |
| Windows agent | `CORAX-Agent.exe` |
| Linux agent | Bash ZIP. Same `agent_env.sh` on every server |

Charts for a host are folded in Postgres (about 800 points), not loaded as every sample. Grafana remains the tool for open-ended metrics. CORAX does not embed a shell.

## Linux servers

**Server audit** is the live view: temperature, CPU, memory, disk, load, network, journal, sensors. A host appears after the first `corax_send.sh`. The panel tells servers apart by `hostname -s`, so those names must be unique.

**Manage** opens on the host card. It is a short allowlist, not Ansible and not SSH:

- check `nginx -t` and `sshd -t`
- service status, and restart only for a fixed list of units
- read a file from a fixed list
- write a file only under nginx/apache config dirs or `/etc/corax`

Editors confirm a restart or a write. Observers do not see job output. The agent pulls one job on its next poll and checks the same rules locally.

LLM cluster control on that host follows the same rule. The agent already reads `nvidia-smi`. The panel scrapes llama-server Prometheus metrics for nodes it can name from inventory. Start, stop, and restart are limited to `llama-server` and `rpc-server-gpu0`…`gpu7`. A model launch writes only `/etc/corax/llama-server.env` and restarts the unit. Role `llm-operator` sees this screen and not the rest of the panel.

Script updates lock a file inside the agent directory (`.corax-update.lock`), not `/tmp`. A lock in `/tmp` can be rejected by the kernel even for root when another user already created it.

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
