# Getting started

After clone there is one command: **`npm run docker:up`**. There is no other supported entry point.

Host Node.js only launches that command (it does not install Playwright or build the UI — the UI is built inside Docker). Host Python 3 is stdlib-only, used to create the first `.env`.

## Requirements

Docker Engine 24+ (Compose v2), Git, Node.js 20+, Python 3 (stdlib).

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 git curl ca-certificates python3
sudo usermod -aG docker "$USER"
# log out of SSH and back in, then: docker ps
```

Install Node.js 20+ from [nodejs.org](https://nodejs.org) (Ubuntu’s `nodejs` package is often too old). Python 3 comes from `apt` above.

## Start

```bash
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax
npm run docker:up
```

The first run builds `corax:local` (minutes: apt + npm + pip + Vite) and waits for health. Later `docker:up` calls **skip the rebuild** if image sources did not change. Force a rebuild with `npm run docker:rebuild`.

Panel: `http://YOUR-LAN-IP:3000/`  
First login: **`admin` / `admin123`** — set your own password immediately.

Firewall: `sudo ufw allow 3000/tcp`

For LAN agents, set in `backend/.env`:

```env
CORAX_ADVERTISE_HOST=192.168.x.x
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://192.168.x.x:3000
```

Then `npm run docker:restart`.

## Run for years without pulling GitHub

The stack does **not** need a nightly `git pull`. Image `corax:local` stays on disk. Postgres and files live in volumes (`corax_pgdata`, `corax_data`, `corax_backups`). `restart: unless-stopped` brings containers back after a VM reboot.

| You can skip | Why it matters |
|--------------|----------------|
| Nightly `git pull` / cron `update.sh` | Optional. Use only if you want new features from GitHub. |
| `npm run docker:rebuild` “just in case” | A rebuild a year later may pull newer Node/Debian bases and break a stack that already works. |
| Root `npm ci` | Installs Playwright for tests. Not required for the panel. |

Still check once a quarter: disk (backups), Local CA expiry if you enabled HTTPS, and that Docker is running. Do not change the agent API (`POST /api/v1/agent/inventory`) without rebuilding agents — the current contract is meant to last.

Details: [docs/docker.md](docs/docker.md).

## Fleet agents

PCs appear under Computers only after an agent report. Build the package **from the panel on the LAN IP**: Settings → Agent build.

- **C++ EXE** — one file, detects Win7/10/11.
- **Windows ZIP** — one archive for 7 and 10/11: run `corax_send.bat`. Install into `%ProgramData%\CORAX\agent`, not the server tree.
- **Linux ZIP** — `/opt/corax-agent` only, not `/opt/corax`.

Never unzip a new agent over a live folder (that wipes the token). Windows: `update_scripts.bat`. Linux: `update_scripts.sh`.

Full guide: [docs/agents.md](docs/agents.md). In the panel: **Knowledge base → Guide**.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run docker:up` | create `.env` if missing and start; builds the image only when needed |
| `npm run docker:rebuild` | force image rebuild |
| `npm run docker:ps` | status |
| `npm run docker:logs` | logs |
| `npm run docker:restart` | restart after `.env` / HTTPS changes |
| `npm run docker:down` | stop (volumes keep data) |
| `./update.sh` | `git pull` + same as `docker:up` (fingerprint rebuild) |

## Optional updates

```bash
cd /opt/corax
./update.sh
```

Nightly cron only if you intentionally want GitHub updates:

```cron
0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
```

If crontab still has `CORAX_DEPLOY=…` or `scripts/corax-docker-update.sh`, remove those lines.
