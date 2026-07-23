## Summary

Release **2.2.0**: Docker production stack + встроенный HTTPS (3 режима), агенты EXE/ZIP, выровненная документация и healthcheck, который не ломается после TLS.

## What's new

- **HTTPS** — HTTP (LAN) / Local CA / корпоративный CA; агенты штампуют `http` или `https` по `agent_scheme`
- **Агенты** — EXE C++ (рекомендуется) и ZIP из панели; `install-corax-ca.bat /machine` для парка
- **Docker** — healthcheck `https -k || http` на `/api/v1/health/ready`; Postgres publish `127.0.0.1:5433`
- **`npm run start:prod`** — `ENVIRONMENT=production` + `PORT=3000`
- **Docs** — README / [deploy/DOCKER.md](deploy/DOCKER.md): Docker-first, CORS `https://`, Visio не в обязательном чеклисте
- **UX** — дашборд заявок, скелетоны, мобильная адаптация, токены темы
- **Security / logs** — headers, rate limits, structured logs в `/data/logs`

## Upgrade

```bash
cd /opt/corax   # или каталог клона
git fetch --tags
git checkout v2.2.0   # или: git pull --ff-only
npm run docker:up
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

После включения HTTPS:

```bash
npm run docker:restart
curl -fsSk https://127.0.0.1:3000/api/v1/health/ready
# пересоберите агентов в панели
```

## Notes

- Не коммитьте `backend/.env` / `.docker-credentials`
- Volumes: `corax_pgdata`, `corax_data` (TLS, логи), `corax_backups`
- Боевой гайд: [deploy/DOCKER.md](deploy/DOCKER.md)
- Предыдущие notes: [RELEASE_NOTES_v2.1.0.md](RELEASE_NOTES_v2.1.0.md)
