"""HTTP security headers — safe defaults that do not break SPA / cookie auth / WebSockets."""
from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Adds hardening headers on every response.

    CSP is applied only in production (and when enabled): the Vite HMR/dev
    proxy must not be constrained. Production SPA is same-origin bundles.
    """

    def __init__(
        self,
        app,
        *,
        environment: str,
        enable_csp: bool = True,
        frame_options: str = "DENY",
    ):
        super().__init__(app)
        self.environment = (environment or "").strip().lower()
        self.enable_csp = enable_csp
        self.frame_options = frame_options or "DENY"

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", self.frame_options)
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )
        response.headers.setdefault("X-XSS-Protection", "0")  # modern browsers: rely on CSP
        response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")

        xf_proto = (request.headers.get("x-forwarded-proto") or "").strip().lower()
        is_https = request.url.scheme == "https" or xf_proto == "https"
        if is_https:
            # LAN self-signed is fine; browsers honor HSTS only on trusted certs.
            response.headers.setdefault(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )

        if self.enable_csp and self.environment == "production":
            # SPA: same-origin bundles; Google Fonts (Inter / JetBrains Mono) from index.html.
            # connect-src: API + diagram WebSocket. style/font: allow fonts.googleapis/gstatic.
            csp = (
                "default-src 'self'; "
                "script-src 'self'; "
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                "img-src 'self' data: blob:; "
                "font-src 'self' data: https://fonts.gstatic.com; "
                "connect-src 'self' ws: wss:; "
                "worker-src 'self' blob:; "
                "frame-ancestors 'none'; "
                "base-uri 'self'; "
                "form-action 'self'; "
                "object-src 'none'"
            )
            response.headers.setdefault("Content-Security-Policy", csp)

        return response
