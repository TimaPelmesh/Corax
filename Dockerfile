# syntax=docker/dockerfile:1.7
#
# Multi-stage production image for CORAX (API + static UI).
#
# Why multi-stage:
# - Node build tools never ship in the runtime image (smaller, fewer CVEs).
# - Python runtime stays slim; system libs only for cairo/SNMP/ping/pg_dump.
#
# Why one process on :3000:
# - Same production model as systemd today (FastAPI serves frontend/dist).
# - Agents and browsers hit one URL; no Vite proxy in prod.

############################
# 1) Frontend build
############################
FROM node:20-bookworm-slim AS frontend-build
WORKDIR /frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

############################
# 2) Python deps (cacheable)
############################
FROM python:3.12-slim-bookworm AS python-deps
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libffi-dev \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt
# Drop test-only packages from the runtime image.
RUN grep -vE '^(pytest|pytest-asyncio)([=<>]|$)' requirements.txt > requirements.prod.txt \
  && pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir -r requirements.prod.txt

############################
# 3) Runtime
############################
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8 \
    CORAX_DOCKER=1 \
    SKIP_ENSURE_POSTGRES=1 \
    ENVIRONMENT=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    RELOAD=0 \
    AGENT_INBOX_DIR=/data/agent_inbox \
    WIKI_RAG_DIR=/data/wiki_rag_docs \
    TLS_DIR=/data/tls \
    LOG_DIR=/data/logs \
    PG_BIN_DIR=/usr/bin

WORKDIR /app

# pg_dump/pg_restore from PGDG (not Debian default 15): Windows dumps are often
# archive format 1.16 (PG 17+) — old client fails with "unsupported version"
# and older code treated that as a soft warning.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
  && mkdir -p /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
       https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgdk-pixbuf-2.0-0 \
    shared-mime-info \
    postgresql-client-17 \
    iputils-ping \
    curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 corax \
  && useradd --system --uid 10001 --gid corax --home-dir /app --shell /usr/sbin/nologin corax \
  && mkdir -p /data/agent_inbox /data/wiki_rag_docs /data/tls /data/backups /data/logs \
  && chown -R corax:corax /data /app

COPY --from=python-deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=python-deps /usr/local/bin /usr/local/bin

COPY --chown=corax:corax run.py ./
COPY --chown=corax:corax scripts ./scripts
COPY --chown=corax:corax backend ./backend
# Agent templates for panel ZIP/EXE builds (PowerShell + stamped C++ EXE)
COPY --chown=corax:corax agent/v3 ./agent/v3
COPY --chown=corax:corax agent/win7 ./agent/win7
COPY --chown=corax:corax agent/cpp ./agent/cpp
COPY --from=frontend-build --chown=corax:corax /frontend/dist ./frontend/dist
COPY --chown=corax:corax deploy/docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && find /app/scripts -name '*.sh' -exec chmod +x {} \; 2>/dev/null || true

USER corax
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/v1/health/ready" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "run.py"]
