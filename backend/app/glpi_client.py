"""GLPI HTTP API: OAuth high-level API (GLPI 11) and legacy apirest.php (GLPI 10)."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import httpx

_PAGE = 100
_CONTENT_LIMIT = 20_000
_OAUTH_ERRORS = frozenset(
    {"invalid_client", "invalid_grant", "unauthorized_client", "invalid_scope", "invalid_request"}
)
_STATUS_LABELS = {
    1: "New",
    2: "Processing (assigned)",
    3: "Processing (planned)",
    4: "Pending",
    5: "Solved",
    6: "Closed",
}
_PRIORITY_LABELS = {
    1: "Very low",
    2: "Low",
    3: "Medium",
    4: "High",
    5: "Very high",
    6: "Major",
}
_BR_RE = re.compile(r"(?i)<\s*br\s*/?\s*>")
_BLOCK_RE = re.compile(r"(?i)</\s*(p|div|li|tr|h[1-6])\s*>")
_TAG_RE = re.compile(r"<[^>]+>")
_HOST_RE = re.compile(r"^[a-zA-Z0-9.-]+(:\d+)?(/.*)?$")


class GlpiClientError(Exception):
    """User-facing GLPI API failure. Must not contain secrets."""


@dataclass(frozen=True)
class GlpiCredentials:
    base_url: str
    api_mode: str = "v2"
    grant_type: str = "password"
    client_id: str = ""
    client_secret: str = ""
    username: str = ""
    password: str = ""
    app_token: str = ""
    user_token: str = ""
    verify_tls: bool = True

    @property
    def mode(self) -> str:
        return "legacy" if (self.api_mode or "").strip().lower() == "legacy" else "v2"

    @property
    def grant(self) -> str:
        grant = (self.grant_type or "password").strip().lower()
        return grant if grant in ("password", "client_credentials") else "password"


@dataclass(frozen=True)
class GlpiTicket:
    glpi_id: int
    title: str
    content: str | None
    status: str
    priority: str
    status_label: str | None
    priority_label: str | None
    updated_at: datetime | None
    opened_at: datetime | None
    closed_at: datetime | None
    requester: str | None
    category: str | None
    location: str | None
    url: str | None


@dataclass(frozen=True)
class GlpiOutbound:
    corax_id: int
    glpi_id: int | None
    title: str
    content: str
    status: str
    priority: str


@dataclass(frozen=True)
class GlpiPushResult:
    corax_id: int
    glpi_id: int | None
    action: str
    error: str | None = None


@dataclass(frozen=True)
class GlpiProbeResult:
    ok: bool
    message: str
    version: str | None
    api_mode: str
    tickets_visible: int


def normalize_base_url(raw: str) -> str:
    text = (raw or "").replace("\u00a0", " ").strip()
    if not text:
        raise GlpiClientError("Укажите URL GLPI")
    if not text.startswith(("http://", "https://")):
        if not _HOST_RE.match(text):
            raise GlpiClientError("URL должен начинаться с http:// или https://")
        text = f"http://{text}"
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise GlpiClientError("Некорректный URL GLPI")
    path = parsed.path or ""
    lowered = path.lower()
    for suffix in ("/apirest.php", "/api.php"):
        idx = lowered.find(suffix)
        if idx >= 0:
            path = path[:idx]
            break
    path = path.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def html_to_text(value: str | None) -> str | None:
    if value is None:
        return None
    text = _BR_RE.sub("\n", str(value))
    text = _BLOCK_RE.sub("\n", text)
    text = _TAG_RE.sub("", text)
    text = html.unescape(text).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return None
    return text[:_CONTENT_LIMIT]


def corax_status(status_id: int | None, status_name: str | None) -> str:
    if status_id == 1:
        return "open"
    if status_id in (2, 3, 4):
        return "in_progress"
    if status_id in (5, 6):
        return "done"
    name = (status_name or "").casefold()
    if any(token in name for token in ("закры", "реш", "solv", "clos")):
        return "done"
    if any(token in name for token in ("обработ", "назнач", "pend", "process", "progress")):
        return "in_progress"
    return "open"


def corax_priority(priority_id: int | None) -> str:
    if priority_id is None:
        return "normal"
    if priority_id <= 2:
        return "low"
    if priority_id >= 4:
        return "high"
    return "normal"


def glpi_status_id(status: str | None) -> int:
    value = (status or "").strip().lower()
    if value == "in_progress":
        return 2
    if value == "cancelled":
        return 6
    if value == "done":
        return 5
    return 1


def glpi_priority_id(priority: str | None) -> int:
    value = (priority or "").strip().lower()
    if value == "low":
        return 2
    if value == "high":
        return 4
    return 3


def glpi_status_label(status: str | None) -> str:
    return _STATUS_LABELS[glpi_status_id(status)]


def glpi_priority_label(priority: str | None) -> str:
    return _PRIORITY_LABELS[glpi_priority_id(priority)]


def parse_glpi_datetime(value: object | None) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.startswith("0000"):
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def parse_ticket(raw: object, *, base_url: str) -> GlpiTicket | None:
    if not isinstance(raw, dict):
        return None
    glpi_id = _as_int(raw.get("id"))
    if glpi_id is None:
        return None
    status_id = _field_id(raw.get("status"))
    status_name = _field_name(raw.get("status")) or _STATUS_LABELS.get(status_id or -1)
    priority_id = _field_id(raw.get("priority"))
    priority_name = _field_name(raw.get("priority")) or _PRIORITY_LABELS.get(priority_id or -1)
    title = _clip(_field_name(raw.get("name")) or raw.get("name") or raw.get("title"), 255)
    if not title:
        title = f"GLPI #{glpi_id}"
    opened = parse_glpi_datetime(raw.get("date") or raw.get("date_creation"))
    updated = parse_glpi_datetime(raw.get("date_mod") or raw.get("date_creation"))
    solved = parse_glpi_datetime(raw.get("date_solve") or raw.get("solvedate"))
    closed = parse_glpi_datetime(raw.get("date_close") or raw.get("closedate")) or solved
    status = corax_status(status_id, status_name)
    return GlpiTicket(
        glpi_id=glpi_id,
        title=title,
        content=html_to_text(_as_text(raw.get("content"))),
        status=status,
        priority=corax_priority(priority_id),
        status_label=_clip(status_name, 64),
        priority_label=_clip(priority_name, 64),
        updated_at=updated,
        opened_at=opened,
        closed_at=closed if status == "done" else None,
        requester=_requester(raw),
        category=_clip(_field_name(raw.get("category") or raw.get("itilcategories_id")), 255),
        location=_clip(_field_name(raw.get("location") or raw.get("locations_id")), 255),
        url=f"{base_url}/front/ticket.form.php?id={glpi_id}",
    )


def probe_glpi(creds: GlpiCredentials, *, transport: httpx.BaseTransport | None = None) -> GlpiProbeResult:
    with _Session(creds, transport) as session:
        sample = session.list_tickets(1)
        version = session.version or None
        return GlpiProbeResult(
            ok=True,
            message="Соединение с GLPI установлено",
            version=version,
            api_mode=session.mode,
            tickets_visible=len(sample),
        )


def fetch_tickets(
    creds: GlpiCredentials,
    limit: int = 200,
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[GlpiTicket]:
    bounded = max(1, min(int(limit), 2000))
    with _Session(creds, transport) as session:
        return session.list_tickets(bounded)


def push_tickets(
    creds: GlpiCredentials,
    items: list[GlpiOutbound],
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[GlpiPushResult]:
    if not items:
        return []
    results: list[GlpiPushResult] = []
    with _Session(creds, transport) as session:
        for item in items:
            try:
                if item.glpi_id:
                    session.update_ticket(item)
                    results.append(
                        GlpiPushResult(corax_id=item.corax_id, glpi_id=item.glpi_id, action="updated")
                    )
                else:
                    created_id = session.create_ticket(item)
                    results.append(
                        GlpiPushResult(corax_id=item.corax_id, glpi_id=created_id, action="created")
                    )
            except GlpiClientError as exc:
                results.append(
                    GlpiPushResult(
                        corax_id=item.corax_id,
                        glpi_id=item.glpi_id,
                        action="failed",
                        error=str(exc),
                    )
                )
    return results


class _Session:
    def __init__(self, creds: GlpiCredentials, transport: httpx.BaseTransport | None) -> None:
        self.creds = creds
        self.base = normalize_base_url(creds.base_url)
        self.mode = creds.mode
        self.version: str | None = None
        self._access = ""
        self._session_token = ""
        self._http = httpx.Client(
            transport=transport,
            verify=bool(creds.verify_tls),
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
            trust_env=False,
            headers={"User-Agent": "CORAX-GLPI/1.0", "Accept": "application/json"},
        )

    def __enter__(self) -> _Session:
        try:
            self._authenticate()
        except Exception:
            self._http.close()
            raise
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            self._logout()
        finally:
            self._http.close()

    def list_tickets(self, limit: int) -> list[GlpiTicket]:
        collected: list[GlpiTicket] = []
        seen: set[int] = set()
        start = 0
        while len(collected) < limit:
            page_size = min(_PAGE, limit - len(collected))
            raw_items = self._list_page(start, page_size)
            if not raw_items:
                break
            fresh = 0
            for raw in raw_items:
                ticket = parse_ticket(raw, base_url=self.base)
                if ticket is None or ticket.glpi_id in seen:
                    continue
                seen.add(ticket.glpi_id)
                collected.append(ticket)
                fresh += 1
                if len(collected) >= limit:
                    break
            if fresh == 0 or len(raw_items) < page_size:
                break
            start += len(raw_items)
        return collected

    def create_ticket(self, item: GlpiOutbound) -> int:
        payload = _outbound_body(item)
        if self.mode == "legacy":
            data = self._request(
                "POST",
                f"{self.base}/apirest.php/Ticket",
                headers=self._legacy_headers(),
                json={"input": payload},
            )
        else:
            data = self._request(
                "POST",
                f"{self.base}/api.php/Assistance/Ticket",
                headers=self._v2_headers(),
                json=payload,
            )
        created = _id_from_payload(data)
        if created is None:
            raise GlpiClientError("GLPI не вернул id созданной заявки")
        return created

    def update_ticket(self, item: GlpiOutbound) -> None:
        if item.glpi_id is None:
            raise GlpiClientError("Нет id заявки GLPI для обновления")
        payload = _outbound_body(item)
        if self.mode == "legacy":
            self._request(
                "PUT",
                f"{self.base}/apirest.php/Ticket/{item.glpi_id}",
                headers=self._legacy_headers(),
                json={"input": payload},
            )
            return
        self._request(
            "PATCH",
            f"{self.base}/api.php/Assistance/Ticket/{item.glpi_id}",
            headers=self._v2_headers(),
            json=payload,
        )

    def _authenticate(self) -> None:
        if self.mode == "legacy":
            self._auth_legacy()
        else:
            self._auth_v2()

    def _auth_v2(self) -> None:
        client_id = (self.creds.client_id or "").strip()
        client_secret = (self.creds.client_secret or "").strip()
        if not client_id or not client_secret:
            raise GlpiClientError(
                "Укажите Client ID и Client secret OAuth-клиента GLPI (Настройка → Клиенты OAuth, scope api)."
            )
        form = {
            "grant_type": self.creds.grant,
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "api",
        }
        if self.creds.grant == "password":
            username = (self.creds.username or "").strip()
            password = self.creds.password or ""
            if not username or not password:
                raise GlpiClientError("Для входа по паролю укажите логин и пароль пользователя GLPI.")
            form["username"] = username
            form["password"] = password
        response = self._http.post(f"{self.base}/api.php/token", data=form)
        if response.status_code >= 400 and not _is_oauth_rejection(response):
            response = self._http.post(f"{self.base}/api.php/token", json=form)
        payload = self._parse(response)
        token = ""
        if isinstance(payload, dict):
            token = str(payload.get("access_token") or "").strip()
        if not token:
            raise GlpiClientError("GLPI не вернул access token")
        self._access = token

    def _auth_legacy(self) -> None:
        app_token = (self.creds.app_token or "").strip()
        user_token = (self.creds.user_token or "").strip()
        if not app_token or not user_token:
            raise GlpiClientError(
                "Укажите App-Token и User-Token (Настройка → Общие → API в GLPI 10)."
            )
        payload = self._parse(
            self._http.get(
                f"{self.base}/apirest.php/initSession",
                headers={
                    "App-Token": app_token,
                    "Authorization": f"user_token {user_token}",
                    "Accept": "application/json",
                },
            )
        )
        session_token = ""
        if isinstance(payload, dict):
            session_token = str(payload.get("session_token") or "").strip()
        if not session_token:
            raise GlpiClientError("GLPI не вернул session token")
        self._session_token = session_token
        self.version = self._read_legacy_version()

    def _read_legacy_version(self) -> str | None:
        try:
            payload = self._parse(
                self._http.get(
                    f"{self.base}/apirest.php/getFullSession",
                    headers=self._legacy_headers(),
                ),
                allow_statuses=(200,),
            )
        except GlpiClientError:
            return None
        return _version_from(payload)

    def _logout(self) -> None:
        if not self._session_token:
            return
        try:
            self._http.get(
                f"{self.base}/apirest.php/killSession",
                headers=self._legacy_headers(),
            )
        except httpx.HTTPError:
            return

    def _list_page(self, start: int, page_size: int) -> list[object]:
        end = start + page_size - 1
        if self.mode == "legacy":
            payload = self._parse(
                self._http.get(
                    f"{self.base}/apirest.php/Ticket",
                    params={"range": f"{start}-{end}", "expand_dropdowns": "true"},
                    headers={
                        **self._legacy_headers(),
                        "Range": f"items={start}-{end}",
                    },
                ),
                empty_on=(404,),
            )
        else:
            payload = self._parse(
                self._http.get(
                    f"{self.base}/api.php/Assistance/Ticket",
                    params={"start": start, "limit": page_size},
                    headers={
                        **self._v2_headers(),
                        "Range": f"items={start}-{end}",
                    },
                ),
                empty_on=(404,),
            )
        return _as_list(payload)

    def _v2_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._access}",
            "Accept": "application/json",
            "Accept-Language": "en_GB",
            "GLPI-Entity-Recursive": "true",
        }

    def _legacy_headers(self) -> dict[str, str]:
        return {
            "App-Token": (self.creds.app_token or "").strip(),
            "Session-Token": self._session_token,
            "Accept": "application/json",
        }

    def _request(self, method: str, url: str, *, headers: dict[str, str], json: dict[str, Any]) -> Any:
        response = self._http.request(method, url, headers=headers, json=json)
        return self._parse(response)

    def _parse(
        self,
        response: httpx.Response,
        *,
        empty_on: tuple[int, ...] = (),
        allow_statuses: tuple[int, ...] = (),
    ) -> Any:
        if response.status_code in empty_on:
            return []
        if response.status_code >= 400 and response.status_code not in allow_statuses:
            raise GlpiClientError(self._error_text(response))
        if response.status_code == 204 or not response.content:
            return {}
        try:
            payload = response.json()
        except ValueError as exc:
            raise GlpiClientError("GLPI вернул не JSON") from exc
        _raise_embedded_error(payload, self.creds)
        return payload

    def _error_text(self, response: httpx.Response) -> str:
        fallback = f"GLPI HTTP {response.status_code}"
        try:
            payload = response.json()
        except ValueError:
            payload = None
        text = _message_from_payload(payload) if payload is not None else (response.text or "")
        cleaned = _redact(text or fallback, self.creds)
        friendly = _friendly(cleaned)
        return friendly or fallback


def _outbound_body(item: GlpiOutbound) -> dict[str, Any]:
    priority = glpi_priority_id(item.priority)
    return {
        "name": (item.title or f"CORAX #{item.corax_id}")[:255],
        "content": item.content or "",
        "status": glpi_status_id(item.status),
        "priority": priority,
        "urgency": priority,
        "impact": 3,
        "type": 1,
        "external_id": f"corax:{item.corax_id}",
    }


def _is_oauth_rejection(response: httpx.Response) -> bool:
    try:
        payload = response.json()
    except ValueError:
        return False
    if not isinstance(payload, dict):
        return False
    return str(payload.get("error") or "") in _OAUTH_ERRORS


def _raise_embedded_error(payload: Any, creds: GlpiCredentials) -> None:
    if isinstance(payload, list) and payload and isinstance(payload[0], str) and payload[0].startswith("ERROR"):
        raise GlpiClientError(_friendly(_redact(" ".join(str(part) for part in payload[:3]), creds)))
    if isinstance(payload, dict):
        message = str(payload.get("message") or "")
        if message.upper().startswith("ERROR"):
            raise GlpiClientError(_friendly(_redact(message, creds)))


def _as_list(payload: Any) -> list[object]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("data", "items", "results"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
        if "id" in payload:
            return [payload]
    return []


def _id_from_payload(payload: Any) -> int | None:
    if isinstance(payload, dict):
        found = _as_int(payload.get("id"))
        if found is not None:
            return found
        nested = payload.get("input")
        if isinstance(nested, dict):
            return _as_int(nested.get("id"))
    if isinstance(payload, list):
        for item in payload:
            found = _id_from_payload(item)
            if found is not None:
                return found
    return None


def _message_from_payload(payload: Any) -> str:
    if isinstance(payload, dict):
        parts: list[str] = []
        for key in ("error", "error_description", "detail", "message", "title"):
            value = payload.get(key)
            if value:
                parts.append(str(value))
        if parts:
            return " ".join(parts)
        return str(payload)
    if isinstance(payload, list):
        return " ".join(str(part) for part in payload[:4])
    return str(payload or "")


def _friendly(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return raw
    mapping = (
        ("ERROR_GLPI_LOGIN_USER_TOKEN", "User-Token отклонён. Проверьте токен пользователя в профиле GLPI."),
        ("ERROR_GLPI_LOGIN", "GLPI отклонил авторизацию. Проверьте токены API."),
        ("ERROR_WRONG_APP_TOKEN", "App-Token не совпадает с настройкой GLPI."),
        ("ERROR_APP_TOKEN_PARAMETERS_MISSING", "Не передан App-Token."),
        ("ERROR_RIGHT_MISSING", "У учётной записи GLPI нет прав на заявки."),
        ("invalid_client", "GLPI не принял Client ID или Client secret."),
        ("invalid_grant", "GLPI не принял логин или пароль."),
        ("unauthorized_client", "Этому OAuth-клиенту не разрешён выбранный способ входа."),
        ("invalid_scope", "OAuth-клиенту нужен scope api."),
    )
    lowered = raw.casefold()
    for code, message in mapping:
        if code.casefold() in lowered:
            return message
    return raw[:400]


def _redact(text: str, creds: GlpiCredentials) -> str:
    cleaned = text or ""
    for secret in (creds.client_secret, creds.password, creds.app_token, creds.user_token):
        value = (secret or "").strip()
        if len(value) >= 4:
            cleaned = cleaned.replace(value, "•••")
    return cleaned


def _version_from(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    sources = [payload]
    cfg = payload.get("cfg_glpi")
    if isinstance(cfg, dict):
        sources.append(cfg)
    for source in sources:
        for key in ("version", "glpi_version", "glpiversion"):
            value = source.get(key)
            if isinstance(value, str) and re.match(r"^\d+\.\d+", value.strip()):
                return value.strip()[:64]
    return None


def _requester(raw: dict[str, Any]) -> str | None:
    for key in ("user_recipient", "users_id_recipient", "requester"):
        name = _field_name(raw.get(key))
        if name and not name.isdigit():
            return _clip(name, 255)
    team = raw.get("team")
    if isinstance(team, list):
        for member in team:
            if not isinstance(member, dict):
                continue
            role = str(member.get("role") or "").casefold()
            if role in ("requester", "request", "инициатор"):
                name = _field_name(member.get("name")) or _as_text(member.get("name"))
                if name:
                    return _clip(name, 255)
    return None


def _field_id(value: object) -> int | None:
    if isinstance(value, dict):
        return _as_int(value.get("id"))
    return _as_int(value)


def _field_name(value: object) -> str | None:
    if isinstance(value, dict):
        for key in ("completename", "name"):
            text = _as_text(value.get(key))
            if text:
                return text
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return None
    return _as_text(value)


def _as_int(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    text = str(value).strip()
    if not text or not re.fullmatch(r"-?\d+", text):
        return None
    return int(text)


def _as_text(value: object) -> str | None:
    if value is None or isinstance(value, (dict, list)):
        return None
    text = str(value).strip()
    return text or None


def _clip(value: object, limit: int) -> str | None:
    text = _as_text(value)
    if text is None:
        return None
    return text[:limit]
