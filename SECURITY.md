# Security policy

CORAX is meant for a **trusted LAN** (office, lab, school). Do not expose the panel to the public internet.

## Reporting a vulnerability

Please **do not** open a public issue with exploit details.

Email the maintainer from the GitHub profile, or open a private security advisory on GitHub:  
https://github.com/TimaPelmesh/Corax/security/advisories/new

Include the affected version (see the latest `v1.2.0` tag), what you observed, and how to reproduce it on a local Docker stack.

## First-run defaults (not production secrets)

A fresh `npm run docker:up` creates `backend/.env` with strong random `SECRET_KEY` / agent pepper values. The **bootstrap panel login** is still:

- username: `admin`
- password: `admin123`

The UI **requires** a password change before the rest of the API works. Change it on first login. Lab Postgres (`inventory` / `inventory` on `127.0.0.1:5433`) is for local Docker only.

Never commit `backend/.env`, agent ZIPs with stamped tokens, `agent_env.bat` / `agent_env.sh`, or TLS private keys.

## What this release does

- Passwords hashed; agent tokens stored as HMAC (pepper in `.env`)
- Rate limits on login and agent inventory
- Security headers (and HSTS when HTTPS is on)
- OpenAPI docs off in production unless `ENABLE_OPENAPI=true`

See [docs/config.md](docs/config.md) and [CHANGELOG.md](CHANGELOG.md).
