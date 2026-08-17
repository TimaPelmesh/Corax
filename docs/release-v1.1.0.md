## CORAX 1.1.0

Second public release of **CORAX** — LAN inventory, light helpdesk, warehouse, network map, WikiRAG.

This is a **trusted LAN** stack (office, lab, school). Do not publish the panel on the public internet. See [SECURITY.md](https://github.com/TimaPelmesh/Corax/blob/v1.1.0/SECURITY.md).

### Highlights

- Warehouse items (one row + quantity), add stock, write-off, CSV into a chosen room
- Ticket templates + printable 5-sheet stats PDF
- Network map as a traceroute/LLDP tree (PCs clustered, not dumped)
- Compact HTTPS and LLM provider chips; HTTPS panels follow the selected mode
- Wider WikiRAG library overlay (indexing/errors in a slim bar; shell chevron stays under the dialog)
- Versions aligned to **1.1.0** (`pyproject.toml`, npm packages, README badge)

### Install (new host)

```bash
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax
git checkout v1.1.0
npm run docker:up
```

Open `http://YOUR-LAN-IP:3000/` and sign in as **`admin` / `admin123`**. The panel **requires** a new password before the rest of the API works (`403 password_change_required` otherwise). Change it on first login.

Lab Postgres (`inventory` / `inventory` on `127.0.0.1:5433`) is for local Docker only. Never commit `backend/.env`.

### Upgrade from 1.0.0

Do not rely on a fingerprint-skip `docker:up` — it can keep a stale `corax:local` and the UI will look like 1.0.0.

```bash
cd /opt/corax   # or your clone
git fetch
git checkout v1.1.0
npm run docker:rebuild
```

On Linux with `update.sh`:

```bash
CORAX_FORCE_BUILD=1 ./update.sh
```

Then smoke: login → change password if this is a fresh volume → warehouse, tickets PDF, network map, WikiRAG library, Settings → HTTPS / AI agent.

If the build fails with `502 Bad Gateway` from `registry-1.docker.io` (Python/Node base images), wait and retry. That is Docker Hub, not the Dockerfile.

### Docs

- [Getting started](https://github.com/TimaPelmesh/Corax/blob/v1.1.0/GETTING_STARTED.md)
- [Changelog](https://github.com/TimaPelmesh/Corax/blob/v1.1.0/CHANGELOG.md)
- [Security](https://github.com/TimaPelmesh/Corax/blob/v1.1.0/SECURITY.md)
- [Contributing](https://github.com/TimaPelmesh/Corax/blob/v1.1.0/CONTRIBUTING.md)
