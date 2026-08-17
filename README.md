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
  <strong>LAN inventory and a light helpdesk — for machines that actually work.</strong><br/>
  Open-source PC fleet inventory, tickets, and network map for offices and labs.
</p>

<p align="center">
  <a href="https://github.com/TimaPelmesh/Corax/actions/workflows/ci.yml"><img src="https://github.com/TimaPelmesh/Corax/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-1f6feb?style=flat-square" alt="License GPLv3" /></a>
  <a href="https://github.com/TimaPelmesh/Corax/releases/tag/v1.2.0"><img src="https://img.shields.io/badge/release-v1.2.0-0e7c66?style=flat-square" alt="Release v1.2.0" /></a>
  <img src="https://img.shields.io/badge/target-LAN%20%2F%20lab%20%2F%20office-6e7781?style=flat-square" alt="Target LAN" />
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

CORAX is a self-hosted panel for a local network: agents report PCs, the UI tracks tickets and warehouse stock, SNMP maps switches and routers, and optional WikiRAG answers from your own docs.

**Run it with Docker only.** Full install: **[GETTING_STARTED.md](GETTING_STARTED.md)**.

| Layer | What it does |
|------|----------------|
| Collection | Windows agents (C++ EXE or one ZIP for 7/10/11) and Linux bash ZIP |
| Panel | Dashboard, computers, tickets, floor map, warehouse, SNMP printers, network topology |
| Integrations | LDAP directory, Bitrix24, WikiRAG, GLPI CSV import |

```bash
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax
npm run docker:up
```

Open `http://YOUR-LAN-IP:3000/` · first login `admin` / `admin123` (you must change the password immediately).

The first image build takes a few minutes. Later `docker:up` calls are seconds unless the code changed. The stack is meant to run for years without `git pull`: the image stays frozen, data lives in volumes, containers restart after a reboot. Updating from GitHub is optional (`./update.sh`).

| Command | Purpose |
|---------|---------|
| `npm run docker:up` | only supported start command (rebuilds the image only when needed) |
| `npm run docker:rebuild` | force-rebuild the image |
| `npm run docker:ps` / `logs` / `restart` / `down` | status, logs, restart, stop |

Docs: [GETTING_STARTED.md](GETTING_STARTED.md) · [docs/docker.md](docs/docker.md) · [docs/agents.md](docs/agents.md) · [docs/config.md](docs/config.md) · [1.2.0 notes](docs/release-v1.2.0.md) · [CHANGELOG](CHANGELOG.md) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md)

**Author:** Timur Ivanov · **License:** [GNU GPL v3](LICENSE) · © 2026
