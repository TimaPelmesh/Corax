from contextlib import asynccontextmanager
from pathlib import Path
import ipaddress
import sys
import time
import uuid
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import JSONResponse
from sqlalchemy import func, select

from app.config import settings
from app.database import AsyncSessionLocal, Base, DiagramsBase, DiagramsSessionLocal, WarehouseBase, WarehouseSessionLocal, diagrams_engine, engine, warehouse_engine
from app.auth import hash_password
from app.migrations import apply_diagrams_migrations, apply_migrations, apply_warehouse_migrations
from app.warehouse_models import StockItem, StockMovement, WarehouseRoom  # noqa: F401 — register ORM metadata
from app.models import ServiceRequestTemplate, Tag, User
from app.routers import (
    agent,
    agent_tokens,
    agent_bundles,
    auth,
    bitrix24,
    bitrix24_bot_handler,
    bitrix24_incoming,
    computers,
    dashboard,
    database_backup,
    diagrams,
    monitors,
    printers,
    request_categories,
    service_requests,
    tags,
    users,
    wikirag,
    warehouse,
    settings as settings_router,
)

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_PROJECT_ROOT = _BACKEND_DIR.parent
_FRONTEND_DIST = _PROJECT_ROOT / "frontend" / "dist"

async def _seed_dev_data(db: AsyncSessionLocal) -> None:
    env = (settings.environment or "").strip().lower()
    if env != "development":
        return

    # Use the first user (bootstrap admin) as author.
    admin = (await db.execute(select(User).order_by(User.id.asc()))).scalars().first()
    if not admin:
        return

    # Do not auto-create tags: directory is managed by admins in UI.

    tpl_cnt = await db.scalar(select(func.count()).select_from(ServiceRequestTemplate))
    if not tpl_cnt:
        db.add_all(
            [
                ServiceRequestTemplate(
                    title="Установка ПО",
                    description="Пожалуйста, установите нужное ПО и укажите версию.",
                    status="open",
                    priority="normal",
                    category="software",
                    created_by_id=admin.id,
                ),
                ServiceRequestTemplate(
                    title="Проблема с оборудованием",
                    description="Опишите проблему, модель/серийный номер и где находится ПК.",
                    status="open",
                    priority="high",
                    category="hardware",
                    created_by_id=admin.id,
                ),
            ]
        )

    await db.commit()

def _cleanup_agent_inbox() -> None:
    base = (settings.agent_inbox_dir or "").strip()
    if not base:
        return
    p = Path(base)
    if not p.is_absolute():
        p = _BACKEND_DIR / p
    if not p.is_dir():
        return
    days = int(getattr(settings, "agent_inbox_retention_days", 0) or 0)
    if days <= 0:
        return
    cutoff = time.time() - (days * 86400)
    try:
        for f in p.glob("*.json"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink(missing_ok=True)
            except OSError:
                continue
    except OSError:
        pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(apply_migrations)

    async with diagrams_engine.begin() as conn:
        # Create only diagrams tables in separate DB (migrations handle CREATE IF NOT EXISTS).
        await conn.run_sync(DiagramsBase.metadata.create_all)
        await conn.run_sync(apply_diagrams_migrations)

    async with warehouse_engine.begin() as conn:
        await conn.run_sync(WarehouseBase.metadata.create_all)
        await conn.run_sync(apply_warehouse_migrations)

    async with WarehouseSessionLocal() as wdb:
        from app.routers.warehouse import ensure_default_warehouse_room

        await ensure_default_warehouse_room(wdb)

    async with AsyncSessionLocal() as db:
        cnt = await db.scalar(select(func.count()).select_from(User))
        if (not cnt or cnt == 0) and settings.bootstrap_admin_username.strip():
            u = settings.bootstrap_admin_username.strip()
            p = (settings.bootstrap_admin_password or "").strip()
            if p:
                db.add(
                    User(
                        username=u,
                        hashed_password=hash_password(p),
                        is_superuser=True,
                        is_active=True,
                        role="editor",
                        is_ldap=False,
                    )
                )
                await db.commit()

        await _seed_dev_data(db)

        from app.printer_poll_config import get_printer_poll_config_row

        await get_printer_poll_config_row(db)

        from app.printer_cleanup import purge_workstation_printers

        try:
            removed = await purge_workstation_printers(db)
            if removed:
                print(
                    f"[CORAX] Вкладка «Принтеры»: убрано {removed} записей с парка ПК "
                    "(остаются только SNMP и ручные).",
                    file=sys.stderr,
                    flush=True,
                )
        except Exception as exc:
            print(f"[CORAX] Очистка принтеров парка ПК: {exc}", file=sys.stderr, flush=True)

    msg = (
        "\n[CORAX] LAN agents: POST /api/v1/agent/inventory (Bearer = agent_token).\n"
        "[CORAX] Подсказка: используйте тот же host/port, что у API (например http://127.0.0.1:3001 или http://<server>:3001).\n"
        "[CORAX] Web UI обычно на http://127.0.0.1:3000 .\n"
    )
    print(msg, file=sys.stderr, flush=True)
    _cleanup_agent_inbox()

    from app.printer_scheduler import printer_poll_scheduler

    env = (settings.environment or "").strip().lower()
    if env != "test":
        await printer_poll_scheduler.start()

    yield

    if env != "test":
        await printer_poll_scheduler.stop()
        await engine.dispose()
        await diagrams_engine.dispose()
        await warehouse_engine.dispose()


def _openapi_paths() -> tuple[str | None, str | None, str | None]:
    env = (settings.environment or "").strip().lower()
    if env == "production" and not settings.enable_openapi:
        return None, None, None
    return "/docs", "/redoc", "/openapi.json"


_docs_url, _redoc_url, _openapi_url = _openapi_paths()
app = FastAPI(
    title="Инвенторизация",
    lifespan=lifespan,
    docs_url=_docs_url,
    redoc_url=_redoc_url,
    openapi_url=_openapi_url,
)

from app.rate_limit import configure_rate_limiting

configure_rate_limiting(app)

app.include_router(bitrix24_bot_handler.router)

origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
# Дедуп при повторяющихся записях в .env
_seen: set[str] = set()
origins = [o for o in origins if not (o in _seen or _seen.add(o))]

if (settings.environment or "").strip().lower() == "development":
    for port in (5173, 3000, 3001, 4173, 8000, 8080):
        for base in ("http://localhost", "http://127.0.0.1"):
            u = f"{base}:{port}"
            if u not in _seen:
                _seen.add(u)
                origins.append(u)


def _is_dev_lan_host(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private and not ip.is_loopback
    except ValueError:
        return False


def _csrf_origin_allowed(origin: str) -> bool:
    if origin in origins:
        return True
    if (settings.environment or "").strip().lower() != "development":
        return False
    try:
        u = urlparse(origin)
        if u.scheme not in ("http", "https"):
            return False
        host = (u.hostname or "").lower()
        if host in ("localhost", "127.0.0.1", "::1"):
            return True
        return _is_dev_lan_host(host)
    except Exception:
        return False


_dev = (settings.environment or "").strip().lower() == "development"
_cors_kw: dict = {
    "allow_credentials": True,
    "allow_methods": ["*"],
    "allow_headers": ["*"],
}
if _dev:
    # В dev коллеги заходят по http://192.168.x.x:3000 — не только localhost.
    _cors_kw["allow_origins"] = origins
    _cors_kw["allow_origin_regex"] = (
        r"https?://(localhost|127\.0\.0\.1|\[::1\]|"
        r"192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
        r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?"
    )
else:
    _cors_kw["allow_origins"] = origins

app.add_middleware(CORSMiddleware, **_cors_kw)

_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_CSRF_EXEMPT_PREFIXES = (
    "/api/v1/auth/login",
    "/api/v1/auth/login/json",
    "/api/v1/auth/logout",
    "/api/v1/agent/",
    "/api/auth/login",
    "/api/auth/login/json",
    "/api/auth/logout",
    "/api/agent/",
)

@app.middleware("http")
async def request_id(request: Request, call_next):
    rid = (request.headers.get("x-request-id") or "").strip()
    if not rid:
        rid = uuid.uuid4().hex
    request.state.request_id = rid
    resp = await call_next(request)
    resp.headers["X-Request-Id"] = rid
    return resp


@app.middleware("http")
async def csrf_and_origin_guard(request: Request, call_next):
    # Basic payload guard for the agent ingest endpoint.
    if request.method.upper() == "POST" and request.url.path in ("/api/v1/agent/inventory", "/api/agent/inventory"):
        cl = request.headers.get("content-length")
        if cl and cl.isdigit():
            n = int(cl)
            if n > int(settings.max_agent_payload_bytes):
                raise HTTPException(status_code=413, detail="Agent payload too large")

    # CSRF is relevant only for browser cookie-based auth on unsafe methods.
    if request.method.upper() not in _UNSAFE_METHODS:
        return await call_next(request)
    path = request.url.path or ""
    if not (path.startswith("/api/") or path.startswith("/api/v1/")):
        return await call_next(request)
    for pfx in _CSRF_EXEMPT_PREFIXES:
        if path.startswith(pfx):
            return await call_next(request)

    authz = (request.headers.get("authorization") or "").strip().lower()
    if authz.startswith("bearer "):
        # Bearer auth is not vulnerable to CSRF in the same way as cookies.
        return await call_next(request)

    if not request.cookies.get("access_token"):
        return await call_next(request)

    origin = (request.headers.get("origin") or "").strip()
    if origin and not _csrf_origin_allowed(origin):
        # JSONResponse: HTTPException из BaseHTTPMiddleware на части стеков даёт 500 вместо 403.
        return JSONResponse({"detail": "CSRF: origin not allowed"}, status_code=403)

    csrf_cookie = (request.cookies.get("csrf_token") or "").strip()
    csrf_header = (request.headers.get("x-csrf-token") or "").strip()
    if not csrf_cookie or not csrf_header or csrf_cookie != csrf_header:
        return JSONResponse({"detail": "CSRF token missing or invalid"}, status_code=403)

    return await call_next(request)

for base in ("/api/v1", "/api"):
    app.include_router(auth.router, prefix=base)
    app.include_router(users.router, prefix=base)
    app.include_router(bitrix24.router, prefix=base)
    app.include_router(bitrix24_incoming.router, prefix=base)
    app.include_router(computers.router, prefix=base)
    app.include_router(monitors.router, prefix=base)
    app.include_router(printers.router, prefix=base)
    app.include_router(diagrams.router, prefix=base)
    app.include_router(dashboard.router, prefix=base)
    app.include_router(tags.router, prefix=base)
    app.include_router(request_categories.router, prefix=base)
    app.include_router(agent.router, prefix=base)
    app.include_router(service_requests.router, prefix=base)
    app.include_router(agent_tokens.router, prefix=base)
    app.include_router(agent_bundles.router, prefix=base)
    app.include_router(settings_router.router, prefix=base)
    app.include_router(database_backup.router, prefix=base)
    app.include_router(wikirag.router, prefix=base)
    app.include_router(warehouse.router, prefix=base)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/v1/health")
async def health_v1():
    from app.local_ip import list_lan_ipv4, pick_primary_lan_ipv4

    return {
        "status": "ok",
        "api": "v1",
        "lan_ip": pick_primary_lan_ipv4(),
        "lan_ips": list_lan_ipv4(),
    }


@app.get("/")
async def root_page():
    index = _FRONTEND_DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    return {
        "service": "Инвенторизация API",
        "docs": "/docs",
        "health": "/api/health",
        "hint": "Соберите фронтенд: npm run build в папке frontend — тогда здесь откроется интерфейс",
    }


if _FRONTEND_DIST.is_dir() and (_FRONTEND_DIST / "index.html").is_file():
    assets = _FRONTEND_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.api_route("/api/v1/{rest:path}", methods=["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
    @app.api_route("/api/{rest:path}", methods=["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
    async def api_unmatched(rest: str):
        """Неизвестный API-метод → 404, а не 405 от GET spa_fallback."""
        raise HTTPException(status_code=404, detail="Not Found")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        root = _FRONTEND_DIST.resolve()
        try:
            candidate = (root / full_path).resolve().relative_to(root)
        except ValueError:
            raise HTTPException(status_code=404, detail="Not Found")
        f = root / candidate
        if f.is_file():
            return FileResponse(f)
        return FileResponse(root / "index.html")
