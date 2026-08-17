## CORAX 1.2.0

Operational release of **CORAX** — faster dashboard and tickets, Risk Center with history and finding management, cleaner Windows agent.

This is a **trusted LAN** stack (office, lab, school). Do not publish the panel on the public internet. See [SECURITY.md](https://github.com/TimaPelmesh/Corax/blob/v1.2.0/SECURITY.md).

### Highlights

- Faster dashboard summary (aggregates + short cache) and ticket list (bulk-load + `skip`)
- Risk Center: fleet health history, acknowledge/ignore findings, open the PC card
- Windows agent splash in blue/white/black; portable agent delivery with DPAPI-bound credentials
- Network map work starts when you open the map, not on every page load

### Install (new host)

```bash
git clone https://github.com/TimaPelmesh/Corax.git
cd Corax
git checkout v1.2.0
npm run docker:up
```

Open `http://YOUR-LAN-IP:3000/` and sign in as **`admin` / `admin123`**. The panel **requires** a new password before the rest of the API works (`403 password_change_required` otherwise). Change it on first login.

Lab Postgres (`inventory` / `inventory` on `127.0.0.1:5433`) is for local Docker only. Never commit `backend/.env`.

### Upgrade from 1.1.0

```bash
cd /opt/corax   # or your clone
git fetch
git checkout v1.2.0
npm run docker:rebuild
```

On Linux with `update.sh`:

```bash
CORAX_FORCE_BUILD=1 ./update.sh
```

Then smoke: login → dashboard → tickets paging → Risk Center → Network map → agent bundle from the panel.

### Docs

- [Getting started](https://github.com/TimaPelmesh/Corax/blob/v1.2.0/GETTING_STARTED.md)
- [Changelog](https://github.com/TimaPelmesh/Corax/blob/v1.2.0/CHANGELOG.md)
- [Security](https://github.com/TimaPelmesh/Corax/blob/v1.2.0/SECURITY.md)
- [Contributing](https://github.com/TimaPelmesh/Corax/blob/v1.2.0/CONTRIBUTING.md)
