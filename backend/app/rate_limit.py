"""HTTP rate limiting (slowapi) for auth and agent endpoints."""

from __future__ import annotations

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)


def configure_rate_limiting(app) -> None:
    from app.config import settings

    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    # @limiter.limit on the route checks the budget itself. SlowAPIMiddleware
    # is BaseHTTPMiddleware: it buffered every response, including the panel,
    # and held the single worker while a tab was still streaming.
    if (settings.environment or "").strip().lower() == "test":
        limiter.enabled = False
