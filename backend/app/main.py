from contextlib import asynccontextmanager
from pathlib import Path
import ipaddress
import time
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse
from sqlalchemy import func, select

from app.config import settings
from app.database import AsyncSessionLocal, Base, DiagramsBase, DiagramsSessionLocal, WarehouseBase, diagrams_engine, engine, warehouse_engine
from app.auth import hash_password
from app.migrations import apply_diagrams_migrations, apply_migrations, apply_warehouse_migrations
from app.observability import (
    RequestIdMiddleware,
    RequestLoggingMiddleware,
    get_logger,
    install_exception_handlers,
    setup_logging,
)
from app.security_headers import SecurityHeadersMiddleware
from app.password_change import bootstrap_must_change_password, PasswordChangeGateMiddleware
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
    network,
    notes,
    printers,
    request_categories,
    risks,
    search,
    self_service,
    service_requests,
    tags,
    ticket_handler,
    users,
    wikirag,
    warehouse,
    zabbix,
    settings as settings_router,
    tls_settings,
)

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_PROJECT_ROOT = _BACKEND_DIR.parent
_FRONTEND_DIST = _PROJECT_ROOT / "frontend" / "dist"
_INDEX_HTML_CACHE: tuple[float, bytes] | None = None


def _cached_index_html() -> Response | None:
    """Serve index.html from memory so SPA navigations do not open a new FD each time."""
    global _INDEX_HTML_CACHE
    path = _FRONTEND_DIST / "index.html"
    if not path.is_file():
        return None
    mtime = path.stat().st_mtime
    if _INDEX_HTML_CACHE is None or _INDEX_HTML_CACHE[0] != mtime:
        _INDEX_HTML_CACHE = (mtime, path.read_bytes())
    return Response(content=_INDEX_HTML_CACHE[1], media_type="text/html; charset=utf-8")

setup_logging(
    environment=settings.environment,
    level=settings.log_level,
    log_dir=settings.log_dir,
    log_to_stdout=settings.log_to_stdout,
    log_to_file=settings.log_to_file,
    log_json=settings.log_json,
    max_bytes=settings.log_max_bytes,
    backup_count=settings.log_backup_count,
    backend_dir=_BACKEND_DIR,
)
log = get_logger("corax.main")


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
    # DDL прогоняется по каждому реально уникальному engine один раз.
    # При совпадающих DSN (Docker по умолчанию) это одна и та же БД —
    # три metadata.create_all() всё равно безопасны (IF NOT EXISTS),
    # но их можно объединить в одну транзакцию: экономит два round-trip
    # `BEGIN/COMMIT` и не открывает лишние коннекты на старте.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(apply_migrations)
        if id(diagrams_engine) == id(engine):
            await conn.run_sync(DiagramsBase.metadata.create_all)
            await conn.run_sync(apply_diagrams_migrations)
        if id(warehouse_engine) == id(engine):
            await conn.run_sync(WarehouseBase.metadata.create_all)
            await conn.run_sync(apply_warehouse_migrations)

    if id(diagrams_engine) != id(engine):
        async with diagrams_engine.begin() as conn:
            # Create only diagrams tables in separate DB (migrations handle CREATE IF NOT EXISTS).
            await conn.run_sync(DiagramsBase.metadata.create_all)
            await conn.run_sync(apply_diagrams_migrations)

    if id(warehouse_engine) != id(engine):
        async with warehouse_engine.begin() as conn:
            await conn.run_sync(WarehouseBase.metadata.create_all)
            await conn.run_sync(apply_warehouse_migrations)

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
                        must_change_password=bootstrap_must_change_password(),
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
                log.info(
                    "purged workstation printers from SNMP tab",
                    extra={"removed": removed},
                )
        except Exception as exc:
            log.warning("printer purge failed: %s", exc)

    log.info(
        "ready — agents POST /api/v1/agent/inventory; UI typically http://127.0.0.1:3000"
    )
    _cleanup_agent_inbox()


    from app.computer_ping_scheduler import computer_ping_scheduler
    from app.printer_scheduler import printer_poll_scheduler
    from app.wikirag_corax_sync import wikirag_corax_sync_scheduler
    from app.wikirag_index_queue import wikirag_index_queue

    await wikirag_index_queue.start()

    env = (settings.environment or "").strip().lower()
    if env != "test":
        await printer_poll_scheduler.start()
        await computer_ping_scheduler.start()
        await wikirag_corax_sync_scheduler.start()

    yield

    await wikirag_index_queue.stop()
    if env != "test":
        await printer_poll_scheduler.stop()
        await computer_ping_scheduler.stop()
        await wikirag_corax_sync_scheduler.stop()
        # Deduplicate: при совпадающих DSN три "разных" engine это один объект.
        seen_engines: set[int] = set()
        for eng in (engine, diagrams_engine, warehouse_engine):
            if id(eng) in seen_engines:
                continue
            seen_engines.add(id(eng))
            await eng.dispose()


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


def _origin_matches_request(origin: str, request: Request) -> bool:
    """Same-origin: browser Origin host:port equals request Host (LAN IP / hostname OK)."""
    try:
        u = urlparse(origin)
        if u.scheme not in ("http", "https") or not u.hostname:
            return False
        req_host = (request.headers.get("host") or "").strip().lower()
        if not req_host or u.netloc.lower() != req_host:
            return False
        xf = (request.headers.get("x-forwarded-proto") or "").strip().lower()
        scheme = "https" if (request.url.scheme == "https" or xf == "https") else "http"
        return u.scheme == scheme
    except Exception:
        return False


def _csrf_origin_allowed(origin: str, request: Request | None = None) -> bool:
    if request is not None and _origin_matches_request(origin, request):
        return True
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

if settings.security_headers_enabled:
    app.add_middleware(
        SecurityHeadersMiddleware,
        environment=settings.environment,
        enable_csp=settings.security_csp_enabled,
    )

# Прозрачное сжатие: JSON дашборда/парка ПК/списка заявок и текстовые SPA-ассеты
# сжимаются 3–5×. WebSocket и уже сжатые ответы Starlette пропускает сам.
# minimum_size — не тратить CPU на короткие 200 OK и подтверждения.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

app.add_middleware(RequestLoggingMiddleware)

install_exception_handlers(app, environment=settings.environment)

_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_CSRF_EXEMPT_PREFIXES = (
    "/api/v1/auth/login",
    "/api/v1/auth/login/json",
    "/api/v1/auth/logout",
    "/api/v1/agent/",
    "/api/v1/self-service/",
    "/api/v1/ticket-handler/intake",
    "/api/v1/ticket-handler/public/",
    "/api/auth/login",
    "/api/auth/login/json",
    "/api/auth/logout",
    "/api/agent/",
    "/api/self-service/",
    "/api/ticket-handler/intake",
    "/api/ticket-handler/public/",
)


class CsrfAndOriginMiddleware:
    """Cookie CSRF + agent payload cap. Pure ASGI (no BaseHTTPMiddleware)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive)
        if request.method.upper() == "POST" and request.url.path in (
            "/api/v1/agent/inventory",
            "/api/agent/inventory",
        ):
            cl = request.headers.get("content-length")
            if cl and cl.isdigit() and int(cl) > int(settings.max_agent_payload_bytes):
                await JSONResponse({"detail": "Agent payload too large"}, status_code=413)(
                    scope, receive, send
                )
                return

        if request.method.upper() not in _UNSAFE_METHODS:
            await self.app(scope, receive, send)
            return
        path = request.url.path or ""
        if not (path.startswith("/api/") or path.startswith("/api/v1/")):
            await self.app(scope, receive, send)
            return
        for pfx in _CSRF_EXEMPT_PREFIXES:
            if path.startswith(pfx):
                await self.app(scope, receive, send)
                return

        authz = (request.headers.get("authorization") or "").strip().lower()
        if authz.startswith("bearer "):
            await self.app(scope, receive, send)
            return

        if not request.cookies.get("access_token"):
            await self.app(scope, receive, send)
            return

        origin = (request.headers.get("origin") or "").strip()
        if origin and not _csrf_origin_allowed(origin, request):
            await JSONResponse({"detail": "CSRF: origin not allowed"}, status_code=403)(
                scope, receive, send
            )
            return

        csrf_cookie = (request.cookies.get("csrf_token") or "").strip()
        csrf_header = (request.headers.get("x-csrf-token") or "").strip()
        if not csrf_cookie or not csrf_header or csrf_cookie != csrf_header:
            await JSONResponse({"detail": "CSRF token missing or invalid"}, status_code=403)(
                scope, receive, send
            )
            return

        await self.app(scope, receive, send)


app.add_middleware(RequestIdMiddleware)
app.add_middleware(CsrfAndOriginMiddleware)
app.add_middleware(PasswordChangeGateMiddleware)


for base in ("/api/v1", "/api"):
    app.include_router(auth.router, prefix=base)
    app.include_router(users.router, prefix=base)
    app.include_router(bitrix24.router, prefix=base)
    app.include_router(bitrix24_incoming.router, prefix=base)
    app.include_router(computers.router, prefix=base)
    app.include_router(monitors.router, prefix=base)
    app.include_router(printers.router, prefix=base)
    app.include_router(network.router, prefix=base)
    app.include_router(diagrams.router, prefix=base)
    app.include_router(dashboard.router, prefix=base)
    app.include_router(tags.router, prefix=base)
    app.include_router(request_categories.router, prefix=base)
    app.include_router(risks.router, prefix=base)
    app.include_router(search.router, prefix=base)
    app.include_router(self_service.router, prefix=base)
    app.include_router(agent.router, prefix=base)
    app.include_router(service_requests.router, prefix=base)
    app.include_router(ticket_handler.router, prefix=base)
    app.include_router(agent_tokens.router, prefix=base)
    app.include_router(agent_bundles.router, prefix=base)
    app.include_router(settings_router.router, prefix=base)
    app.include_router(tls_settings.router, prefix=base)
    app.include_router(database_backup.router, prefix=base)
    app.include_router(wikirag.router, prefix=base)
    app.include_router(warehouse.router, prefix=base)
    app.include_router(notes.router, prefix=base)
    app.include_router(zabbix.router, prefix=base)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/v1/health")
async def health_v1():
    return {
        "status": "ok",
        "api": "v1",
    }


@app.get("/api/v1/health/ready")
async def health_ready():
    """Readiness: process up + PostgreSQL reachable (compose HEALTHCHECK / k8s probes)."""
    from sqlalchemy import text

    from app.database import AsyncSessionLocal

    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "database": "down"},
        )
    # No LAN discovery here — Docker healthcheck timeout is 5s; keep this DB-only.
    return {
        "status": "ok",
        "api": "v1",
        "database": "up",
    }


@app.get("/")
async def root_page():
    cached = _cached_index_html()
    if cached is not None:
        return cached
    return {
        "service": "Инвенторизация API",
        "docs": "/docs",
        "health": "/api/health",
        "hint": "Соберите фронтенд: npm run build в папке frontend — тогда здесь откроется интерфейс",
    }


class _ImmutableStaticFiles(StaticFiles):
    """StaticFiles с длинным Cache-Control для хеш-нэймд артефактов Vite.

    Vite emits `assets/<name>.<hash>.<ext>` — имя меняется при каждой сборке,
    поэтому 1 год + immutable безопасны и убирают повторные загрузки JS/CSS/шрифтов
    при навигациях между страницами.
    """

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        try:
            response.headers.setdefault(
                "Cache-Control", "public, max-age=31536000, immutable"
            )
        except Exception:
            pass
        return response


if _FRONTEND_DIST.is_dir() and (_FRONTEND_DIST / "index.html").is_file():
    assets = _FRONTEND_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", _ImmutableStaticFiles(directory=str(assets)), name="assets")

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
        cached = _cached_index_html()
        if cached is not None:
            return cached
        raise HTTPException(status_code=404, detail="Not Found")
