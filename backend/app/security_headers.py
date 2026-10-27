"""HTTP security headers — pure ASGI (no BaseHTTPMiddleware / TaskGroup)."""
from __future__ import annotations

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Receive, Scope, Send


class SecurityHeadersMiddleware:
    """Adds hardening headers on every response.

    CSP is applied only in production (and when enabled): the Vite HMR/dev
    proxy must not be constrained. Production SPA is same-origin bundles.

    Pure ASGI send-wrapper: does not buffer FileResponse / StaticFiles and does
    not leak FDs the way Starlette BaseHTTPMiddleware TaskGroups can.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        environment: str,
        enable_csp: bool = True,
        frame_options: str = "DENY",
    ):
        self.app = app
        self.environment = (environment or "").strip().lower()
        self.enable_csp = enable_csp
        self.frame_options = frame_options or "DENY"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        header_map = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        xf_proto = (header_map.get("x-forwarded-proto") or "").strip().lower()
        peer = ""
        client = scope.get("client")
        if client:
            peer = client[0] if isinstance(client, (list, tuple)) else str(client)
        from app.net_trust import request_is_https

        is_https = request_is_https(scope.get("scheme"), xf_proto, peer)
        apply_csp = self.enable_csp and self.environment == "production"
        frame_options = self.frame_options

        async def send_wrapper(message: dict) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("X-Content-Type-Options", "nosniff")
                headers.setdefault("X-Frame-Options", frame_options)
                headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
                headers.setdefault(
                    "Permissions-Policy",
                    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
                )
                headers.setdefault("X-XSS-Protection", "0")
                headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
                if is_https:
                    headers.setdefault(
                        "Strict-Transport-Security",
                        "max-age=31536000; includeSubDomains",
                    )
                if apply_csp:
                    # SPA: same-origin bundles + /theme-boot.js (no inline scripts).
                    # Google Fonts (Inter / JetBrains Mono) from index.html.
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
                    headers.setdefault("Content-Security-Policy", csp)
            await send(message)

        await self.app(scope, receive, send_wrapper)
