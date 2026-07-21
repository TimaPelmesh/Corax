## Summary

Production-ready single-host release: one Docker stack for the panel, API, Postgres, and automated backups.

## What's new

- **Docker Compose** — `db` (Postgres 16) + `app` (UI+API on :3000) + `db-backup` (nightly `pg_dump -Fc`)
- **Docs** — [deploy/DOCKER.md](deploy/DOCKER.md), README Docker quick start
- **Ops** — `npm run docker:up|down|restart|logs|ps`
- **Stability** — readiness probe is DB-only; fleet ping no longer freezes the API under UI sweeps
- **Safety** — secrets only in `backend/.env` (gitignored); image build excludes `**/.env`

## Upgrade

```bash
cp backend/.env.example backend/.env
# set SECRET_KEY, AGENT_TOKEN, AGENT_TOKEN_PEPPER,
# BOOTSTRAP_ADMIN_PASSWORD, POSTGRES_PASSWORD
npm run docker:up
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

## Notes

- Do **not** commit `backend/.env`
- Local data lives in Docker volumes (`corax_pgdata`, `corax_data`, `corax_backups`)
- Logs: container stdout (`npm run docker:logs`) and files under `/data/logs/` (`corax.jsonl` / `corax.log`)
- Security headers (CSP in production) are on by default; login uses HttpOnly cookies (`return_token` defaults to false)
