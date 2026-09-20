# Security policy

CORAX is meant for a **trusted LAN** (office, lab, school). Do not expose the panel to the public internet.

## Reporting a vulnerability

Please **do not** open a public issue with exploit details.

Email the maintainer from the GitHub profile, or open a private security advisory on GitHub:  
https://github.com/TimaPelmesh/Corax/security/advisories/new

Include the affected version (see the latest `v1.3.0` tag), what you observed, and how to reproduce it on a local Docker stack.

## First-run defaults (not production secrets)

A fresh `npm run docker:up` creates `backend/.env` with strong random `SECRET_KEY` / agent pepper values. The **bootstrap panel login** is still:

- username: `admin`
- password: `admin123`

The UI **requires** a password change before the rest of the API works. Change it on first login. Lab Postgres (`inventory` / `inventory` on `127.0.0.1:5433`) is for local Docker only.

Never commit `backend/.env`, agent ZIPs with stamped tokens, `agent_env.bat` / `agent_env.sh`, or TLS private keys.

## What this release does

- Passwords hashed; agent tokens stored as HMAC (pepper in `.env`)
- Rate limits on login and agent inventory
- Security headers (and HSTS when HTTPS is on, only if the request is HTTPS or the peer is in `TRUSTED_PROXY_IPS`)
- OpenAPI docs off in production unless `ENABLE_OPENAPI=true`
- `/h` intake: kiosk secret **or** a hostname that already exists in inventory (X-Forwarded-For / SSO headers ignored unless `TRUSTED_PROXY_IPS` is set)
- Shared `AGENT_TOKEN` cannot overwrite an existing PC when MAC/serial disagree
- Observer role does not receive SNMP community or `/h` client_secret
- Panel JWT is versioned: logout and password change revoke previous sessions
- Notes HTML is sanitized; unauthenticated `/api/v1/health` does not list LAN IPs

## Agent (C++, Windows) — credential storage and hardening

- The panel-generated `.zip` ships a one-time `agent.provision.json`. On first
  launch it is protected with **Windows DPAPI `LocalMachine`**, written back as
  hidden `agent.cred`, and the provisioning file is overwritten with zeros and
  deleted. No plaintext token stays on disk.
- HTTPS uploads: **TLS 1.2 is the enforced minimum** and certificate
  validation is never disabled (see `agent/cpp/src/http.cpp`). An unpatched
  host must be updated instead of falling back to older TLS.
- Every launch runs behind a **process-wide crash handler** — SEH exceptions
  in WMI providers, schannel, or DPAPI are translated to `std::runtime_error`
  and produce a `corax-agent-crash-<ts>.dmp` next to the EXE plus a readable
  line in `corax-agent.log` (module + offset). This replaces the previous
  "just disappears after splash" failure mode with something diagnosable.

See [docs/config.md](docs/config.md) and [CHANGELOG.md](CHANGELOG.md).
