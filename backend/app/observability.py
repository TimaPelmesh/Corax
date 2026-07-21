"""Structured logging for CORAX.

Destinations (both enabled by default when log_to_file is on):
  1. stdout — Docker / systemd / `npm run docker:logs`
  2. rotating files under LOG_DIR — `corax.jsonl` (JSON) + optional human `corax.log`

Every HTTP request gets a request_id (incoming X-Request-Id or generated).
The same id is injected into log records via contextvars and returned as X-Request-Id.
"""
from __future__ import annotations

import json
import logging
import logging.handlers
import sys
import time
import traceback
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

request_id_var: ContextVar[str] = ContextVar("corax_request_id", default="-")

_CONFIGURED = False
_LOG = logging.getLogger("corax")


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get("-")  # type: ignore[attr-defined]
        return True


class JsonFormatter(logging.Formatter):
    """One JSON object per line — greppable, shippable to Loki/ELK later."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        # Extra fields from logger.info("...", extra={...}) that are not standard LogRecord attrs
        skip = {
            "name",
            "msg",
            "args",
            "created",
            "filename",
            "funcName",
            "levelname",
            "levelno",
            "lineno",
            "module",
            "msecs",
            "message",
            "pathname",
            "process",
            "processName",
            "relativeCreated",
            "stack_info",
            "exc_info",
            "exc_text",
            "thread",
            "threadName",
            "request_id",
            "taskName",
        }
        for key, value in record.__dict__.items():
            if key in skip or key.startswith("_"):
                continue
            try:
                json.dumps(value)
                payload[key] = value
            except (TypeError, ValueError):
                payload[key] = repr(value)
        return json.dumps(payload, ensure_ascii=False)


class HumanFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        rid = getattr(record, "request_id", "-")
        base = f"{self.formatTime(record, self.datefmt)} | {record.levelname:<7} | {rid} | {record.name} | {record.getMessage()}"
        if record.exc_info:
            base += "\n" + self.formatException(record.exc_info)
        return base


def _resolve_log_dir(raw: str, backend_dir: Path) -> Path:
    p = Path((raw or "").strip() or "logs")
    if not p.is_absolute():
        p = backend_dir / p
    return p


def setup_logging(
    *,
    environment: str,
    level: str = "INFO",
    log_dir: str = "logs",
    log_to_stdout: bool = True,
    log_to_file: bool = True,
    log_json: bool | None = None,
    max_bytes: int = 10_485_760,
    backup_count: int = 14,
    backend_dir: Path | None = None,
) -> Path | None:
    """Configure root + uvicorn loggers once. Returns resolved log directory or None."""
    global _CONFIGURED
    if _CONFIGURED:
        return _resolve_log_dir(log_dir, backend_dir or Path(__file__).resolve().parent.parent)

    env = (environment or "").strip().lower()
    if log_json is None:
        log_json = env == "production"

    lvl = getattr(logging, (level or "INFO").strip().upper(), logging.INFO)
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(lvl)

    rid_filter = RequestIdFilter()
    handlers: list[logging.Handler] = []

    if log_to_stdout:
        sh = logging.StreamHandler(sys.stdout)
        sh.setLevel(lvl)
        sh.addFilter(rid_filter)
        sh.setFormatter(JsonFormatter() if log_json else HumanFormatter(datefmt="%Y-%m-%d %H:%M:%S"))
        handlers.append(sh)

    resolved: Path | None = None
    if log_to_file and env != "test":
        resolved = _resolve_log_dir(log_dir, backend_dir or Path(__file__).resolve().parent.parent)
        try:
            resolved.mkdir(parents=True, exist_ok=True)
            # Machine-readable primary file (always JSON lines for shipping).
            jh = logging.handlers.RotatingFileHandler(
                resolved / "corax.jsonl",
                maxBytes=max(max_bytes, 1_048_576),
                backupCount=max(backup_count, 1),
                encoding="utf-8",
            )
            jh.setLevel(lvl)
            jh.addFilter(rid_filter)
            jh.setFormatter(JsonFormatter())
            handlers.append(jh)

            # Human-readable companion (handy on the host without jq).
            hh = logging.handlers.RotatingFileHandler(
                resolved / "corax.log",
                maxBytes=max(max_bytes, 1_048_576),
                backupCount=max(backup_count, 1),
                encoding="utf-8",
            )
            hh.setLevel(lvl)
            hh.addFilter(rid_filter)
            hh.setFormatter(HumanFormatter(datefmt="%Y-%m-%d %H:%M:%S"))
            handlers.append(hh)
        except OSError as exc:
            # Fall back to stdout only — never block startup on log dir permissions.
            sys.stderr.write(f"[CORAX] log file setup failed ({exc}); stdout only\n")
            resolved = None

    for h in handlers:
        root.addHandler(h)

    # Keep uvicorn access quieter; we emit our own access line with request_id.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.error").setLevel(lvl)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

    _CONFIGURED = True
    _LOG.info(
        "logging configured",
        extra={
            "environment": env,
            "log_json": bool(log_json),
            "log_to_stdout": log_to_stdout,
            "log_to_file": bool(resolved),
            "log_dir": str(resolved) if resolved else None,
        },
    )
    return resolved


def get_logger(name: str = "corax") -> logging.Logger:
    return logging.getLogger(name)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Access log + request_id context for the whole request lifecycle."""

    _SKIP_ACCESS = {"/api/v1/health", "/api/v1/health/ready", "/api/health"}

    async def dispatch(self, request: Request, call_next) -> Response:
        import uuid as _uuid

        rid = (getattr(request.state, "request_id", None) or "").strip()
        if not rid:
            rid = (request.headers.get("x-request-id") or "").strip() or _uuid.uuid4().hex
            request.state.request_id = rid
        token = request_id_var.set(rid)
        started = time.perf_counter()
        path = request.url.path or ""
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            _LOG.exception(
                "unhandled error",
                extra={
                    "method": request.method,
                    "path": path,
                    "duration_ms": duration_ms,
                    "client": request.client.host if request.client else None,
                },
            )
            request_id_var.reset(token)
            raise

        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        if path not in self._SKIP_ACCESS:
            _LOG.info(
                "request",
                extra={
                    "method": request.method,
                    "path": path,
                    "status": response.status_code,
                    "duration_ms": duration_ms,
                    "client": request.client.host if request.client else None,
                },
            )
        response.headers.setdefault("X-Request-Id", rid)
        request_id_var.reset(token)
        return response


def install_exception_handlers(app, *, environment: str) -> None:
    """Log unhandled errors; hide stack traces from clients outside development."""
    from fastapi import FastAPI, Request
    from fastapi.exceptions import RequestValidationError
    from fastapi.exception_handlers import request_validation_exception_handler

    assert isinstance(app, FastAPI)
    env = (environment or "").strip().lower()
    expose = env == "development"

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        _LOG.warning(
            "validation error",
            extra={"path": request.url.path, "errors": exc.errors()[:8]},
        )
        # Preserve FastAPI's default 422 body shape (frontend already parses it).
        return await request_validation_exception_handler(request, exc)

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception):
        from fastapi import HTTPException
        from fastapi.exception_handlers import http_exception_handler

        # Do not swallow HTTPException / Starlette HTTPException subclasses.
        if isinstance(exc, HTTPException):
            return await http_exception_handler(request, exc)

        rid = getattr(request.state, "request_id", "-")
        _LOG.error(
            "unhandled exception",
            extra={
                "path": request.url.path,
                "exc_type": type(exc).__name__,
                "traceback": traceback.format_exc() if expose else None,
            },
            exc_info=True,
        )
        body: dict[str, Any] = {
            "detail": "Internal server error",
            "request_id": rid,
        }
        if expose:
            body["error"] = str(exc)
            body["exc_type"] = type(exc).__name__
        return JSONResponse(status_code=500, content=body, headers={"X-Request-Id": rid or "-"})
