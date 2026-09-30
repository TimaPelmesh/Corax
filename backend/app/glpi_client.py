"""GLPI HTTP API: OAuth high-level API (GLPI 11) and legacy apirest.php (GLPI 10)."""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Callable
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
    requester: str | None = None
    assignee: str | None = None
    category: str | None = None


@dataclass(frozen=True)
class GlpiPushResult:
    corax_id: int
    glpi_id: int | None
    action: str
    error: str | None = None
    detail: str | None = None


def _titles_match(left: str | None, right: str | None) -> bool:
    a = " ".join((left or "").casefold().split())
    b = " ".join((right or "").casefold().split())
    return bool(a) and a == b


def _is_permission_error(exc: Exception) -> bool:
    text = str(exc).casefold()
    return any(
        token in text
        for token in (
            "don't have permission",
            "нет прав",
            "error_right",
            "error_glpi_update",
            "error_right_missing",
        )
    )


@dataclass(frozen=True)
class GlpiIdentity:
    """Публичные поля сессии. Секреты и токены сюда не попадают."""

    user_id: int | None = None
    username: str | None = None
    display_name: str | None = None
    profile: str | None = None
    entity: str | None = None


@dataclass(frozen=True)
class GlpiProbeResult:
    ok: bool
    message: str
    version: str | None
    api_mode: str
    tickets_visible: int
    identity: GlpiIdentity | None = None


@dataclass(frozen=True)
class GlpiTestTicketResult:
    ok: bool
    message: str
    glpi_id: int | None = None
    url: str | None = None
    identity: GlpiIdentity | None = None
    version: str | None = None
    api_mode: str | None = None


@dataclass(frozen=True)
class GlpiSoftware:
    name: str
    version: str | None = None
    link_id: int | None = None
    version_id: int | None = None


@dataclass(frozen=True)
class GlpiComputer:
    glpi_id: int
    name: str
    serial: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    location: str | None = None
    os_name: str | None = None
    os_version: str | None = None
    comment: str | None = None
    # None — список ПО неизвестен (не затирать). Пустой кортеж — в GLPI программ нет.
    software: tuple[GlpiSoftware, ...] | None = None


@dataclass(frozen=True)
class GlpiComputerOutbound:
    corax_id: int
    hostname: str
    serial: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    location: str | None = None
    os_name: str | None = None
    os_version: str | None = None
    comment: str | None = None
    ip_address: str | None = None
    software: tuple[tuple[str, str | None], ...] = ()


@dataclass(frozen=True)
class GlpiAssetPushResult:
    corax_id: int
    glpi_id: int | None
    action: str
    error: str | None = None


@dataclass(frozen=True)
class GlpiDevice:
    glpi_id: int
    name: str
    serial: str | None = None
    inventory: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    location: str | None = None
    contact: str | None = None
    comment: str | None = None
    organization: str | None = None
    updated_at: datetime | None = None
    created_at: datetime | None = None


@dataclass(frozen=True)
class GlpiDeviceOutbound:
    corax_id: int
    kind: str
    name: str
    glpi_id: int | None = None
    serial: str | None = None
    inventory: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    location: str | None = None
    contact: str | None = None
    comment: str | None = None


@dataclass(frozen=True)
class GlpiDevicePushResult:
    corax_id: int
    glpi_id: int | None
    action: str
    updated_at: datetime | None = None
    error: str | None = None


def canonical_software(name: str | None, version: str | None) -> tuple[str, str | None] | None:
    title = re.sub(r"\s+", " ", name or "").strip()
    if not title:
        return None
    ver = re.sub(r"\s+", " ", version or "").strip()
    if ver == "-":
        ver = ""
    return title[:512], (ver[:255] or None)


def software_key(name: str | None, version: str | None) -> tuple[str, str]:
    canon = canonical_software(name, version)
    if canon is None:
        return "", ""
    title, ver = canon
    return title.casefold(), (ver or "").casefold()


def same_software_set(
    left: list[tuple[str, str | None]] | tuple[tuple[str, str | None], ...],
    right: list[tuple[str, str | None]] | tuple[tuple[str, str | None], ...],
) -> bool:
    def keys(items: list[tuple[str, str | None]] | tuple[tuple[str, str | None], ...]) -> set[tuple[str, str]]:
        return {software_key(name, version) for name, version in items if software_key(name, version) != ("", "")}

    return keys(left) == keys(right)


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


def device_is_stale(incoming: datetime | None, stored: datetime | None) -> bool:
    """True when the incoming GLPI stamp is strictly older than the stored one.

    Seconds are the GLPI precision. A newer or equal stamp may update the row.
    """
    if incoming is None or stored is None:
        return False
    return _floor_utc(incoming) < _floor_utc(stored)


def _floor_utc(value: datetime) -> datetime:
    current = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return current.replace(microsecond=0)


def _device_itemtype(kind: str) -> str:
    if kind == "monitor":
        return "Monitor"
    if kind == "printer":
        return "Printer"
    raise GlpiClientError("Можно передать только мониторы или принтеры")


def parse_device(raw: object) -> GlpiDevice | None:
    if not isinstance(raw, dict):
        return None
    glpi_id = _as_int(raw.get("id"))
    name = _clip(raw.get("name"), 255)
    if glpi_id is None or not name:
        return None
    if _as_int(raw.get("is_deleted")) == 1 or _as_int(raw.get("is_template")) == 1:
        return None
    model = raw.get("model") or raw.get("monitormodels_id") or raw.get("printermodels_id")
    return GlpiDevice(
        glpi_id=glpi_id,
        name=name,
        serial=_clip(raw.get("serial"), 255),
        inventory=_clip(raw.get("otherserial"), 128),
        manufacturer=_clip(raw.get("manufacturer") or raw.get("manufacturers_id"), 255),
        model=_clip(model, 255),
        location=_clip(raw.get("location") or raw.get("locations_id"), 255),
        contact=_clip(raw.get("contact"), 255),
        comment=_clip(raw.get("comment"), 8000),
        organization=_clip(raw.get("entities_id") or raw.get("entity"), 255),
        updated_at=parse_glpi_datetime(raw.get("date_mod") or raw.get("date_creation")),
        created_at=parse_glpi_datetime(raw.get("date_creation") or raw.get("date")),
    )


def fetch_devices(
    creds: GlpiCredentials,
    kind: str,
    limit: int = 200,
    *,
    glpi_ids: list[int] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> list[GlpiDevice]:
    bounded = max(1, min(int(limit), 2000))
    only: set[int] | None = None
    if glpi_ids is not None:
        only = set()
        for item in glpi_ids:
            only.add(int(item))
            if len(only) >= 2000:
                break
        if not only:
            return []
        bounded = len(only)
    with _Session(creds, transport) as session:
        return session.list_devices(kind, bounded, only)


def push_devices(
    creds: GlpiCredentials,
    items: list[GlpiDeviceOutbound],
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[GlpiDevicePushResult]:
    if not items:
        return []
    results: list[GlpiDevicePushResult] = []
    with _Session(creds, transport) as session:
        for item in items:
            try:
                results.append(session.upsert_device(item))
            except GlpiClientError as exc:
                results.append(
                    GlpiDevicePushResult(
                        corax_id=item.corax_id,
                        glpi_id=None,
                        action="failed",
                        error=str(exc),
                    )
                )
    return results


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
        identity = session.read_identity()
        sample = session.list_tickets(1)
        version = session.version or None
        who = _identity_label(identity, creds)
        return GlpiProbeResult(
            ok=True,
            message=f"Соединение с GLPI установлено. Работаете как: {who}",
            version=version,
            api_mode=session.mode,
            tickets_visible=len(sample),
            identity=identity,
        )


def create_test_ticket(
    creds: GlpiCredentials,
    *,
    title: str,
    content: str,
    transport: httpx.BaseTransport | None = None,
) -> GlpiTestTicketResult:
    """Создаёт одну заявку в GLPI от имени текущего профиля. Локальную заявку CORAX не трогает."""
    cleaned_title = (title or "").strip()[:255] or "CORAX — тестовая заявка"
    cleaned_content = (content or "").strip()[:_CONTENT_LIMIT] or (
        "Тестовая заявка из панели CORAX. Можно закрыть или удалить в GLPI."
    )
    with _Session(creds, transport) as session:
        identity = session.read_identity()
        created_id = session.create_ticket(
            GlpiOutbound(
                corax_id=0,
                glpi_id=None,
                title=cleaned_title,
                content=cleaned_content,
                status="open",
                priority="low",
            )
        )
        url = f"{session.base}/front/ticket.form.php?id={created_id}"
        who = _identity_label(identity, creds)
        return GlpiTestTicketResult(
            ok=True,
            message=f"Заявка #{created_id} создана от имени «{who}»",
            glpi_id=created_id,
            url=url,
            identity=identity,
            version=session.version,
            api_mode=session.mode,
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
    on_progress: Callable[[int, int, GlpiPushResult], None] | None = None,
) -> list[GlpiPushResult]:
    """CREATE / UPDATE с сопоставлением по glpi_id или точному названию.

    CREATE работает у профиля с правом на создание. UPDATE может падать на
    чужой сущности — тогда при отсутствии заявки с тем же названием создаём
    новую и перепривязываем, дубликат по названию не плодим.
    """
    if not items:
        return []
    results: list[GlpiPushResult] = []
    total = len(items)
    with _Session(creds, transport) as session:
        for index, item in enumerate(items, start=1):
            try:
                result = session.upsert_ticket(item)
            except GlpiClientError as exc:
                result = GlpiPushResult(
                    corax_id=item.corax_id,
                    glpi_id=item.glpi_id,
                    action="failed",
                    error=str(exc),
                )
            results.append(result)
            if on_progress is not None:
                on_progress(index, total, result)
    return results


def fetch_computers(
    creds: GlpiCredentials,
    limit: int = 200,
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[GlpiComputer]:
    bounded = max(1, min(int(limit), 2000))
    with _Session(creds, transport) as session:
        return session.list_computers(bounded)


def push_computers(
    creds: GlpiCredentials,
    items: list[GlpiComputerOutbound],
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[GlpiAssetPushResult]:
    if not items:
        return []
    results: list[GlpiAssetPushResult] = []
    with _Session(creds, transport) as session:
        for item in items:
            try:
                results.append(session.upsert_computer(item))
            except GlpiClientError as exc:
                results.append(
                    GlpiAssetPushResult(
                        corax_id=item.corax_id,
                        glpi_id=None,
                        action="failed",
                        error=str(exc),
                    )
                )
    return results


def parse_computer(raw: object) -> GlpiComputer | None:
    if not isinstance(raw, dict):
        return None
    glpi_id = _as_int(raw.get("id"))
    name = _clip(raw.get("name"), 255)
    if glpi_id is None or not name:
        return None
    software: tuple[GlpiSoftware, ...] | None = None
    embedded = raw.get("_softwares")
    if isinstance(embedded, list):
        parsed = [item for item in (parse_software_install(row) for row in embedded) if item is not None and item.name]
        software = tuple(parsed)
    return GlpiComputer(
        glpi_id=glpi_id,
        name=name,
        serial=_clip(raw.get("serial") or raw.get("serial_number"), 128),
        manufacturer=_dropdown_label(raw.get("manufacturer") or raw.get("manufacturers_id")),
        model=_dropdown_label(raw.get("model") or raw.get("computermodels_id")),
        location=_dropdown_label(raw.get("location") or raw.get("locations_id")),
        os_name=_dropdown_label(raw.get("os_name") or raw.get("operatingsystems_id")),
        os_version=_dropdown_label(raw.get("os_version") or raw.get("operatingsystemversions_id"), 255),
        comment=_clip(raw.get("comment") or raw.get("notes"), 8000),
        software=software,
    )


def parse_software_install(raw: object) -> GlpiSoftware | None:
    if not isinstance(raw, dict):
        return None
    version_value = raw.get("version")
    if version_value is None:
        version_value = raw.get("softwareversions_id")
    version_name: str | None = None
    version_id: int | None = None
    software_from_version: str | None = None
    if isinstance(version_value, dict):
        version_name = _clip(version_value.get("name"), 255)
        version_id = _as_int(version_value.get("id"))
        nested = version_value.get("software") or version_value.get("softwares_id")
        software_from_version = _clip(_field_name(nested), 512)
        if version_id is None:
            version_id = _as_int(nested) if not isinstance(nested, dict) else _as_int(nested.get("id") if isinstance(nested, dict) else None)
    else:
        version_id = _as_int(version_value)
        if version_id is None:
            version_name = _clip(version_value, 255)
    name = (
        _clip(_field_name(raw.get("software")), 512)
        or _clip(_field_name(raw.get("softwares_id")), 512)
        or software_from_version
    )
    if name is None:
        plain = _clip(raw.get("name"), 512)
        if plain and plain != version_name:
            name = plain
    link_id = _as_int(raw.get("id"))
    if version_id is not None and link_id == version_id and raw.get("softwareversions_id") is not None:
        link_id = _as_int(raw.get("link_id"))
    if not name and version_id is None and not version_name:
        return None
    return GlpiSoftware(name=name or "", version=version_name, link_id=link_id, version_id=version_id)


class _Session:
    def __init__(self, creds: GlpiCredentials, transport: httpx.BaseTransport | None) -> None:
        self.creds = creds
        self.base = normalize_base_url(creds.base_url)
        self.mode = creds.mode
        self.version: str | None = None
        self._access = ""
        self._session_token = ""
        self._cached_identity: GlpiIdentity | None = None
        self._name_ids: dict[tuple[object, ...], int] = {}
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

    def read_identity(self) -> GlpiIdentity:
        """Кто сейчас авторизован и какой активный профиль. Без секретов."""
        if self._cached_identity is not None:
            return self._cached_identity
        if self.mode == "legacy":
            payload = self._full_session_payload(self._legacy_headers())
            identity = parse_glpi_identity(payload)
            if identity.username or identity.profile or identity.user_id:
                self._cached_identity = identity
                return identity
        else:
            for headers in (self._v2_headers(), self._asset_headers()):
                payload = self._full_session_payload(headers)
                identity = parse_glpi_identity(payload)
                if identity.username or identity.profile or identity.user_id:
                    self._cached_identity = identity
                    return identity
            me = self._user_me_payload()
            identity = parse_glpi_identity(me)
            if identity.username or identity.display_name or identity.user_id:
                self._cached_identity = identity
                return identity
        username = _clip(self.creds.username, 255) if self.creds.grant == "password" else None
        if not username and self.mode == "v2" and self.creds.grant == "client_credentials":
            username = "oauth-client"
        identity = GlpiIdentity(username=username)
        self._cached_identity = identity
        return identity

    def _full_session_payload(self, headers: dict[str, str]) -> Any | None:
        try:
            return self._parse(
                self._http.get(f"{self.base}/apirest.php/getFullSession", headers=headers),
                allow_statuses=(200,),
                empty_on=(401, 403, 404),
            )
        except GlpiClientError:
            return None

    def _user_me_payload(self) -> Any | None:
        for path in (
            f"{self.base}/api.php/Administration/User/Me",
            f"{self.base}/api.php/Administration/User/me",
        ):
            try:
                return self._parse(
                    self._http.get(path, headers=self._v2_headers()),
                    allow_statuses=(200,),
                    empty_on=(401, 403, 404),
                )
            except GlpiClientError:
                continue
        return None

    def create_ticket(self, item: GlpiOutbound) -> int:
        payload = self._ticket_payload(item, for_update=False)
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
        self._apply_ticket_meta(created, item)
        return created

    def update_ticket(self, item: GlpiOutbound) -> None:
        if item.glpi_id is None:
            raise GlpiClientError("Нет id заявки GLPI для обновления")
        payload = self._ticket_payload(item, for_update=True)
        if self.mode == "legacy":
            self._request(
                "PUT",
                f"{self.base}/apirest.php/Ticket/{item.glpi_id}",
                headers=self._legacy_headers(),
                json={"input": payload},
            )
        else:
            self._request(
                "PATCH",
                f"{self.base}/api.php/Assistance/Ticket/{item.glpi_id}",
                headers=self._v2_headers(),
                json=payload,
            )
        self._apply_ticket_meta(item.glpi_id, item)

    def _ticket_payload(self, item: GlpiOutbound, *, for_update: bool) -> dict[str, Any]:
        body = _outbound_body(item, for_update=for_update)
        category_id = self._resolve_category_id(item.category)
        if category_id is not None:
            body["itilcategories_id"] = category_id
        requester_id = self._resolve_user_id(item.requester)
        if requester_id is not None:
            body["_users_id_requester"] = requester_id
        assignee_id = self._resolve_user_id(item.assignee)
        if assignee_id is not None:
            body["_users_id_assign"] = assignee_id
        return body

    def _resolve_category_id(self, name: str | None) -> int | None:
        cleaned = (name or "").strip()
        if not cleaned:
            return None
        # Не создаём дерево категорий молча — только ищем существующую.
        for row in self._search_named("ITILCategory", cleaned):
            row_name = (_as_text(row.get("name")) or _as_text(row.get("completename")) or "").casefold()
            if cleaned.casefold() in row_name or row_name == cleaned.casefold():
                found = _as_int(row.get("id"))
                if found is not None:
                    return found
        try:
            return self._ensure_item("ITILCategory", cleaned)
        except GlpiClientError:
            return None

    def _resolve_user_id(self, name: str | None) -> int | None:
        cleaned = (name or "").strip()
        if not cleaned:
            return None
        cache_key = ("User", cleaned.casefold(), ())
        cached = self._name_ids.get(cache_key)
        if cached is not None:
            return cached
        needle = cleaned.casefold()
        for row in self._search_named("User", cleaned):
            if not isinstance(row, dict):
                continue
            candidates = [
                _as_text(row.get("name")),
                _as_text(row.get("realname")),
                _as_text(row.get("firstname")),
                " ".join(
                    part
                    for part in (_as_text(row.get("firstname")), _as_text(row.get("realname")))
                    if part
                ).strip()
                or None,
            ]
            if any(c and c.casefold() == needle for c in candidates if c):
                found = _as_int(row.get("id"))
                if found is not None:
                    self._name_ids[cache_key] = found
                    return found
        # Доп. поиск по login через searchText[name] уже выше; пробуем точный GET search.
        return None

    def _apply_ticket_meta(self, ticket_id: int, item: GlpiOutbound) -> None:
        """Инициатор / ответственный / категория — и для закрытых заявок тоже.

        Пустые значения из CORAX не затирают уже заполненные поля в GLPI.
        """
        category_id = self._resolve_category_id(item.category)
        if category_id is not None:
            try:
                self._request(
                    "PUT",
                    f"{self.base}/apirest.php/Ticket/{ticket_id}",
                    headers=self._asset_headers(),
                    json={"input": {"itilcategories_id": category_id}},
                )
            except GlpiClientError:
                pass
        requester_id = self._resolve_user_id(item.requester)
        if requester_id is not None:
            self._ensure_ticket_actor(ticket_id, requester_id, actor_type=1)
        assignee_id = self._resolve_user_id(item.assignee)
        if assignee_id is not None:
            self._ensure_ticket_actor(ticket_id, assignee_id, actor_type=2)

    def _ensure_ticket_actor(self, ticket_id: int, user_id: int, *, actor_type: int) -> None:
        """type 1 = инициатор (requester), 2 = ответственный (assign)."""
        try:
            rows = self._legacy_page(
                f"{self.base}/apirest.php/Ticket/{ticket_id}/Ticket_User",
                params={},
            ) or []
        except GlpiClientError:
            rows = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            if _as_int(row.get("type")) != actor_type:
                continue
            if _as_int(row.get("users_id")) == user_id:
                return
            link_id = _as_int(row.get("id"))
            if link_id is not None:
                try:
                    self._request(
                        "PUT",
                        f"{self.base}/apirest.php/Ticket_User/{link_id}",
                        headers=self._asset_headers(),
                        json={"input": {"users_id": user_id, "type": actor_type}},
                    )
                    return
                except GlpiClientError:
                    break
        try:
            self._request(
                "POST",
                f"{self.base}/apirest.php/Ticket_User",
                headers=self._asset_headers(),
                json={
                    "input": {
                        "tickets_id": ticket_id,
                        "users_id": user_id,
                        "type": actor_type,
                        "use_notification": 0,
                    }
                },
            )
        except GlpiClientError:
            return

    def find_ticket_id_by_title(self, title: str) -> int | None:
        """Точное совпадение названия (без учёта регистра и лишних пробелов)."""
        needle = " ".join((title or "").split())
        if not needle:
            return None
        for raw in self._search_tickets_by_name(needle):
            if not isinstance(raw, dict):
                continue
            name = _clip(raw.get("name") or raw.get("title"), 255)
            if _titles_match(name, needle):
                found = _as_int(raw.get("id"))
                if found is not None:
                    return found
        return None

    def _search_tickets_by_name(self, name: str) -> list[object]:
        cleaned = name[:255]
        if self.mode == "legacy":
            payload = self._parse(
                self._http.get(
                    f"{self.base}/apirest.php/Ticket",
                    params={
                        "searchText[name]": cleaned,
                        "range": "0-49",
                        "expand_dropdowns": "true",
                    },
                    headers={**self._legacy_headers(), "Range": "items=0-49"},
                ),
                empty_on=(404,),
            )
            return _as_list(payload)
        payload = self._parse(
            self._http.get(
                f"{self.base}/api.php/Assistance/Ticket",
                params={"start": 0, "limit": 50, "filter[name]": cleaned},
                headers={**self._v2_headers(), "Range": "items=0-49"},
            ),
            empty_on=(404,),
        )
        rows = _as_list(payload)
        if rows:
            return rows
        # Fallback: legacy search under OAuth (часто доступен на GLPI 11).
        payload = self._parse(
            self._http.get(
                f"{self.base}/apirest.php/Ticket",
                params={"searchText[name]": cleaned, "range": "0-49"},
                headers={**self._asset_headers(), "Range": "items=0-49"},
            ),
            empty_on=(401, 403, 404),
        )
        return _as_list(payload) if payload else []

    def upsert_ticket(self, item: GlpiOutbound) -> GlpiPushResult:
        """Связь по glpi_id или точному названию → UPDATE, иначе CREATE."""
        title = (item.title or f"CORAX #{item.corax_id}").strip()
        target_id = item.glpi_id
        matched_by = "id" if target_id else None
        if target_id is None:
            target_id = self.find_ticket_id_by_title(title)
            if target_id is not None:
                matched_by = "title"

        if target_id is not None:
            try:
                self.update_ticket(replace(item, glpi_id=target_id, title=title))
                return GlpiPushResult(
                    corax_id=item.corax_id,
                    glpi_id=target_id,
                    action="updated",
                    detail=f"сопоставлено по {matched_by}",
                )
            except GlpiClientError as exc:
                if not _is_permission_error(exc):
                    raise
                # UPDATE чужой/чужой сущности: не плодим дубликат с тем же названием.
                same_title_id = self.find_ticket_id_by_title(title)
                if same_title_id is not None:
                    raise GlpiClientError(
                        f"Заявка «{title[:80]}» уже есть в GLPI #{same_title_id}, "
                        f"но у профиля нет UPDATE. Дубликат не создан. "
                        f"Выдайте права или снимите связь glpi_id в CORAX."
                    ) from exc
                # Старая связь недоступна и названия в GLPI нет — создаём новую.
                created_id = self.create_ticket(replace(item, glpi_id=None, title=title))
                return GlpiPushResult(
                    corax_id=item.corax_id,
                    glpi_id=created_id,
                    action="created",
                    detail=(
                        f"старая связь GLPI #{target_id} недоступна (нет UPDATE), "
                        f"создана новая #{created_id}"
                    ),
                )

        created_id = self.create_ticket(replace(item, glpi_id=None, title=title))
        return GlpiPushResult(
            corax_id=item.corax_id,
            glpi_id=created_id,
            action="created",
            detail="новая заявка",
        )

    def list_computers(self, limit: int) -> list[GlpiComputer]:
        collected: list[GlpiComputer] = []
        seen: set[int] = set()
        start = 0
        while len(collected) < limit:
            page_size = min(_PAGE, limit - len(collected))
            raw_items = self._computer_page(start, page_size)
            if not raw_items:
                break
            fresh = 0
            for raw in raw_items:
                if not isinstance(raw, dict):
                    continue
                if _as_int(raw.get("is_deleted")) == 1 or _as_int(raw.get("is_template")) == 1:
                    continue
                computer = parse_computer(raw)
                if computer is None or computer.glpi_id in seen:
                    continue
                seen.add(computer.glpi_id)
                software = self._software_for(computer.glpi_id)
                os_name, os_version = self._os_for(computer.glpi_id)
                computer = replace(
                    computer,
                    software=software,
                    os_name=computer.os_name or os_name,
                    os_version=computer.os_version or os_version,
                )
                collected.append(computer)
                fresh += 1
                if len(collected) >= limit:
                    break
            if fresh == 0 or len(raw_items) < page_size:
                break
            start += len(raw_items)
        return collected

    def list_devices(self, kind: str, limit: int, only_ids: set[int] | None = None) -> list[GlpiDevice]:
        itemtype = _device_itemtype(kind)
        if only_ids is not None:
            found: list[GlpiDevice] = []
            for glpi_id in list(only_ids)[:limit]:
                device = parse_device(self._read_asset(itemtype, glpi_id))
                if device is not None:
                    found.append(device)
            return found
        collected: list[GlpiDevice] = []
        seen: set[int] = set()
        start = 0
        while len(collected) < limit:
            page_size = min(_PAGE, limit - len(collected))
            raw_items = self._device_page(itemtype, start, page_size)
            if not raw_items:
                break
            fresh = 0
            for raw in raw_items:
                device = parse_device(raw)
                if device is None or device.glpi_id in seen:
                    continue
                seen.add(device.glpi_id)
                collected.append(device)
                fresh += 1
                if len(collected) >= limit:
                    break
            if fresh == 0 or len(raw_items) < page_size:
                break
            start += len(raw_items)
        return collected

    def upsert_device(self, item: GlpiDeviceOutbound) -> GlpiDevicePushResult:
        itemtype = _device_itemtype(item.kind)
        name = (item.name or "").strip()
        if not name:
            raise GlpiClientError("У записи нет имени")
        existing: GlpiDevice | None = None
        if item.glpi_id is not None:
            existing = parse_device(self._read_asset(itemtype, item.glpi_id))
        if existing is None:
            existing = self._find_device(itemtype, name, item.serial, item.inventory)
        glpi_id = self._write_device(None if existing is None else existing.glpi_id, item)
        fresh = parse_device(self._read_asset(itemtype, glpi_id))
        return GlpiDevicePushResult(
            corax_id=item.corax_id,
            glpi_id=glpi_id,
            action="created" if existing is None else "updated",
            updated_at=None if fresh is None else fresh.updated_at,
        )

    def upsert_computer(self, item: GlpiComputerOutbound) -> GlpiAssetPushResult:
        hostname = (item.hostname or "").strip()
        if not hostname:
            raise GlpiClientError("У компьютера нет имени")
        match = self._find_computer(hostname, item.serial)
        if match is None:
            glpi_id = self._write_computer(None, item)
            action = "created"
        else:
            glpi_id = match.glpi_id
            self._write_computer(glpi_id, item)
            action = "updated"
        self._replace_software(glpi_id, item.software)
        self._write_os(glpi_id, item.os_name, item.os_version)
        self._ensure_computer_ip(glpi_id, item.ip_address)
        return GlpiAssetPushResult(corax_id=item.corax_id, glpi_id=glpi_id, action=action)

    def _device_page(self, itemtype: str, start: int, page_size: int) -> list[object]:
        end = start + page_size - 1
        if self.mode == "legacy":
            payload = self._read(
                f"{self.base}/apirest.php/{itemtype}",
                params={"range": f"{start}-{end}", "expand_dropdowns": "true", "get_hateoas": "false"},
                headers={**self._asset_headers(), "Range": f"items={start}-{end}"},
            )
        else:
            payload = self._read(
                f"{self.base}/api.php/Assets/{itemtype}",
                params={"start": start, "limit": page_size},
                headers={**self._v2_headers(), "Range": f"items={start}-{end}"},
            )
        if payload is None:
            return []
        return _as_list(payload)

    def _read_asset(self, itemtype: str, item_id: int) -> dict[str, Any] | None:
        if self.mode == "legacy":
            payload = self._read(
                f"{self.base}/apirest.php/{itemtype}/{item_id}",
                params={"expand_dropdowns": "true", "get_hateoas": "false"},
                headers=self._asset_headers(),
            )
        else:
            payload = self._read(
                f"{self.base}/api.php/Assets/{itemtype}/{item_id}",
                headers=self._v2_headers(),
            )
        return payload if isinstance(payload, dict) else None

    def _search_devices(self, itemtype: str, field: str, value: str) -> list[GlpiDevice]:
        if self.mode == "legacy":
            payload = self._read(
                f"{self.base}/apirest.php/{itemtype}",
                params={
                    f"searchText[{field}]": value,
                    "expand_dropdowns": "true",
                    "range": "0-49",
                    "get_hateoas": "false",
                },
                headers={**self._asset_headers(), "Range": "items=0-49"},
            )
        else:
            payload = self._read(
                f"{self.base}/api.php/Assets/{itemtype}",
                params={"filter": f"{field}=={value}", "start": 0, "limit": 50},
                headers=self._v2_headers(),
            )
        if payload is None:
            return []
        found: list[GlpiDevice] = []
        for raw in _as_list(payload):
            device = parse_device(raw)
            if device is not None:
                found.append(device)
        return found

    def _find_device(self, itemtype: str, name: str, serial: str | None, inventory: str | None) -> GlpiDevice | None:
        probes = (("serial", serial), ("otherserial", inventory), ("name", name))
        for field, raw in probes:
            text = (raw or "").strip()
            if not text:
                continue
            matches = [
                device
                for device in self._search_devices(itemtype, field, text)
                if (self._device_field(device, field) or "").casefold() == text.casefold()
            ]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise GlpiClientError(f"В GLPI несколько {itemtype} с {field}={text}")
        return None

    @staticmethod
    def _device_field(device: GlpiDevice, field: str) -> str | None:
        if field == "serial":
            return device.serial
        if field == "otherserial":
            return device.inventory
        return device.name

    def _write_device(self, glpi_id: int | None, item: GlpiDeviceOutbound) -> int:
        itemtype = _device_itemtype(item.kind)
        legacy_body: dict[str, Any] = {"name": item.name.strip()[:255]}
        v2_body: dict[str, Any] = {"name": item.name.strip()[:255]}
        for field, raw, limit in (
            ("serial", item.serial, 255),
            ("otherserial", item.inventory, 255),
            ("contact", item.contact, 255),
            ("comment", item.comment, 8000),
        ):
            text = (raw or "").strip()
            if not text:
                continue
            legacy_body[field] = text[:limit]
            v2_body[field] = text[:limit]
        model_field, model_type = (
            ("monitormodels_id", "MonitorModel") if itemtype == "Monitor" else ("printermodels_id", "PrinterModel")
        )
        for label, legacy_field, v2_field, dropdown in (
            (item.manufacturer, "manufacturers_id", "manufacturer", "Manufacturer"),
            (item.model, model_field, "model", model_type),
            (item.location, "locations_id", "location", "Location"),
        ):
            text = (label or "").strip()
            if not text:
                continue
            ref = self._dropdown_id(dropdown, text)
            if ref is not None:
                legacy_body[legacy_field] = ref
                v2_body[v2_field] = {"id": ref}
            elif self.mode != "legacy":
                v2_body[v2_field] = {"name": text[:255]}
        if self.mode == "legacy":
            if glpi_id is None:
                data = self._request(
                    "POST",
                    f"{self.base}/apirest.php/{itemtype}",
                    headers=self._asset_headers(),
                    json={"input": legacy_body},
                )
            else:
                self._request(
                    "PUT",
                    f"{self.base}/apirest.php/{itemtype}/{glpi_id}",
                    headers=self._asset_headers(),
                    json={"input": legacy_body},
                )
                return glpi_id
        elif glpi_id is None:
            data = self._request(
                "POST",
                f"{self.base}/api.php/Assets/{itemtype}",
                headers=self._v2_headers(),
                json=v2_body,
            )
        else:
            self._request(
                "PATCH",
                f"{self.base}/api.php/Assets/{itemtype}/{glpi_id}",
                headers=self._v2_headers(),
                json=v2_body,
            )
            return glpi_id
        created = _id_from_payload(data)
        if created is None:
            raise GlpiClientError("GLPI не вернул id созданной записи")
        return created

    def _computer_page(self, start: int, page_size: int) -> list[object]:
        end = start + page_size - 1
        if self.mode == "legacy":
            payload = self._read(
                f"{self.base}/apirest.php/Computer",
                params={"range": f"{start}-{end}", "expand_dropdowns": "true", "get_hateoas": "false"},
                headers={**self._asset_headers(), "Range": f"items={start}-{end}"},
            )
        else:
            payload = self._read(
                f"{self.base}/api.php/Assets/Computer",
                params={"start": start, "limit": page_size},
                headers={**self._v2_headers(), "Range": f"items={start}-{end}"},
            )
        if payload is None:
            return []
        return _as_list(payload)

    def _find_computer(self, hostname: str, serial: str | None) -> GlpiComputer | None:
        for computer in self._search_computers("name", hostname):
            if computer.name.casefold() == hostname.casefold():
                return computer
        serial_text = (serial or "").strip()
        if not serial_text:
            return None
        matches = [
            computer
            for computer in self._search_computers("serial", serial_text)
            if (computer.serial or "").casefold() == serial_text.casefold()
        ]
        if len(matches) == 1:
            return matches[0]
        return None

    def _search_computers(self, field: str, value: str) -> list[GlpiComputer]:
        if self.mode == "legacy":
            payload = self._read(
                f"{self.base}/apirest.php/Computer",
                params={
                    f"searchText[{field}]": value,
                    "expand_dropdowns": "true",
                    "range": "0-49",
                    "get_hateoas": "false",
                },
                headers={**self._asset_headers(), "Range": "items=0-49"},
            )
        else:
            payload = self._read(
                f"{self.base}/api.php/Assets/Computer",
                params={"filter": f"{field}=={value}", "start": 0, "limit": 50},
                headers=self._v2_headers(),
            )
        if payload is None:
            return []
        found: list[GlpiComputer] = []
        for raw in _as_list(payload):
            if not isinstance(raw, dict):
                continue
            if _as_int(raw.get("is_deleted")) == 1 or _as_int(raw.get("is_template")) == 1:
                continue
            computer = parse_computer(raw)
            if computer is not None:
                found.append(computer)
        return found

    def _write_computer(self, glpi_id: int | None, item: GlpiComputerOutbound) -> int:
        hostname = item.hostname.strip()[:255]
        legacy_body: dict[str, Any] = {"name": hostname}
        v2_body: dict[str, Any] = {"name": hostname}
        if item.serial:
            legacy_body["serial"] = item.serial.strip()[:255]
            v2_body["serial"] = item.serial.strip()[:255]
        comment = _comment_with_ip(item.comment, item.ip_address)
        if comment:
            legacy_body["comment"] = comment[:8000]
            v2_body["comment"] = comment[:8000]
        for label, legacy_field, v2_field in (
            (item.manufacturer, "manufacturers_id", "manufacturer"),
            (item.model, "computermodels_id", "model"),
            (item.location, "locations_id", "location"),
        ):
            if not label or not label.strip():
                continue
            itemtype = {"manufacturers_id": "Manufacturer", "computermodels_id": "ComputerModel", "locations_id": "Location"}[
                legacy_field
            ]
            ref = self._dropdown_id(itemtype, label.strip())
            if ref is not None:
                legacy_body[legacy_field] = ref
                v2_body[v2_field] = {"id": ref}
            elif self.mode != "legacy":
                v2_body[v2_field] = {"name": label.strip()[:255]}
        if self.mode == "legacy":
            if glpi_id is None:
                data = self._request(
                    "POST",
                    f"{self.base}/apirest.php/Computer",
                    headers=self._asset_headers(),
                    json={"input": legacy_body},
                )
            else:
                data = self._request(
                    "PUT",
                    f"{self.base}/apirest.php/Computer/{glpi_id}",
                    headers=self._asset_headers(),
                    json={"input": legacy_body},
                )
                return glpi_id
        elif glpi_id is None:
            data = self._request(
                "POST",
                f"{self.base}/api.php/Assets/Computer",
                headers=self._v2_headers(),
                json=v2_body,
            )
        else:
            self._request(
                "PATCH",
                f"{self.base}/api.php/Assets/Computer/{glpi_id}",
                headers=self._v2_headers(),
                json=v2_body,
            )
            return glpi_id
        created = _id_from_payload(data)
        if created is None:
            raise GlpiClientError("GLPI не вернул id компьютера")
        return created

    def _software_for(self, computer_id: int) -> tuple[GlpiSoftware, ...] | None:
        rows = self._legacy_page(f"{self.base}/apirest.php/Computer/{computer_id}/Item_SoftwareVersion")
        if rows is None:
            return None
        installed: list[GlpiSoftware] = []
        for raw in rows:
            if not isinstance(raw, dict) or _as_int(raw.get("is_deleted")) == 1:
                continue
            parsed = parse_software_install(raw)
            if parsed is None:
                continue
            if parsed.name:
                installed.append(parsed)
                continue
            if parsed.version_id is None:
                continue
            version_name, software_name = self._version_names(parsed.version_id)
            if not software_name:
                continue
            installed.append(
                GlpiSoftware(
                    name=software_name,
                    version=version_name,
                    link_id=parsed.link_id,
                    version_id=parsed.version_id,
                )
            )
        return tuple(installed)

    def _version_names(self, version_id: int) -> tuple[str | None, str | None]:
        payload = self._read_item("SoftwareVersion", version_id)
        if payload is None:
            return None, None
        version_name = _clip(payload.get("name"), 255)
        software_id = _as_int(payload.get("softwares_id"))
        software_name = _clip(_field_name(payload.get("softwares_id")), 512) if software_id is None else None
        if software_id is not None:
            software = self._read_item("Software", software_id)
            if software is not None:
                software_name = _clip(software.get("name"), 512)
        return version_name, software_name

    def _os_for(self, computer_id: int) -> tuple[str | None, str | None]:
        rows = self._legacy_page(
            f"{self.base}/apirest.php/Computer/{computer_id}/Item_OperatingSystem",
            params={"expand_dropdowns": "true"},
        )
        if not rows:
            return None, None
        raw = rows[0]
        if not isinstance(raw, dict):
            return None, None
        return (
            _dropdown_label(raw.get("operatingsystems_id")),
            _dropdown_label(raw.get("operatingsystemversions_id")),
        )

    def _replace_software(self, computer_id: int, software: tuple[tuple[str, str | None], ...]) -> None:
        current = self._software_for(computer_id)
        if current is None:
            raise GlpiClientError("GLPI не отдал список установленного ПО")
        desired: dict[tuple[str, str], tuple[str, str | None]] = {}
        for name, version in software:
            canon = canonical_software(name, version)
            if canon is None:
                continue
            desired.setdefault(software_key(*canon), canon)
        have: dict[tuple[str, str], list[GlpiSoftware]] = {}
        for item in current:
            canon = canonical_software(item.name, item.version)
            if canon is None:
                continue
            have.setdefault(software_key(*canon), []).append(item)
        for key, links in have.items():
            if key in desired:
                continue
            for link in links:
                if link.link_id is not None:
                    self._delete_install(link.link_id)
        for key, (name, version) in desired.items():
            if key in have:
                continue
            version_id = self._ensure_software_version(name, version)
            self._add_install(computer_id, version_id)

    def _ensure_software_version(self, name: str, version: str | None) -> int:
        software_id = self._ensure_item("Software", name)
        version_name = (version or "-").strip() or "-"
        for row in self._search_named("SoftwareVersion", version_name):
            row_name = (_as_text(row.get("name")) or "").casefold()
            if row_name != version_name.casefold():
                continue
            if _as_int(row.get("softwares_id")) != software_id:
                continue
            found = _as_int(row.get("id"))
            if found is not None:
                return found
        return self._create_item(
            "SoftwareVersion",
            {"name": version_name[:255], "softwares_id": software_id},
        )

    def _write_os(self, computer_id: int, os_name: str | None, os_version: str | None) -> None:
        if not (os_name or "").strip() and not (os_version or "").strip():
            return
        rows = self._legacy_page(f"{self.base}/apirest.php/Computer/{computer_id}/Item_OperatingSystem")
        if rows is None:
            return
        payload: dict[str, Any] = {}
        os_id = self._dropdown_id("OperatingSystem", os_name.strip()) if (os_name or "").strip() else None
        if os_id is not None:
            payload["operatingsystems_id"] = os_id
        if (os_version or "").strip():
            extra = {"operatingsystems_id": os_id} if os_id is not None else None
            ver_id = self._dropdown_id("OperatingSystemVersion", os_version.strip(), extra)
            if ver_id is not None:
                payload["operatingsystemversions_id"] = ver_id
        if not payload:
            return
        existing_id = _as_int(rows[0].get("id")) if rows and isinstance(rows[0], dict) else None
        if existing_id is not None:
            self._request(
                "PUT",
                f"{self.base}/apirest.php/Item_OperatingSystem/{existing_id}",
                headers=self._asset_headers(),
                json={"input": payload},
            )
            return
        payload["itemtype"] = "Computer"
        payload["items_id"] = computer_id
        self._request(
            "POST",
            f"{self.base}/apirest.php/Item_OperatingSystem",
            headers=self._asset_headers(),
            json={"input": payload},
        )

    def _ensure_computer_ip(self, computer_id: int, ip_address: str | None) -> None:
        """Пишет IPv4 в NetworkPort GLPI (best-effort; ошибка не валит выгрузку ПК)."""
        ip = (ip_address or "").strip()
        if not ip:
            return
        try:
            ports = self._legacy_page(
                f"{self.base}/apirest.php/Computer/{computer_id}/NetworkPort",
                params={},
            ) or []
        except GlpiClientError:
            return
        port_id: int | None = None
        for row in ports:
            if not isinstance(row, dict):
                continue
            port_id = _as_int(row.get("id"))
            if port_id is not None:
                break
        try:
            if port_id is None:
                created = self._request(
                    "POST",
                    f"{self.base}/apirest.php/NetworkPort",
                    headers=self._asset_headers(),
                    json={
                        "input": {
                            "itemtype": "Computer",
                            "items_id": computer_id,
                            "name": "CORAX",
                            "instantiation_type": "NetworkPortEthernet",
                        }
                    },
                )
                port_id = _id_from_payload(created)
            if port_id is None:
                return
            self._request(
                "PUT",
                f"{self.base}/apirest.php/NetworkPort/{port_id}",
                headers=self._asset_headers(),
                json={"input": {"ip": ip, "name": "CORAX"}},
            )
        except GlpiClientError:
            return

    def _dropdown_id(self, itemtype: str, name: str, extra: dict[str, Any] | None = None) -> int | None:
        try:
            return self._ensure_item(itemtype, name, extra)
        except GlpiClientError:
            if self.mode == "legacy":
                raise
            return None

    def _ensure_item(self, itemtype: str, name: str, extra: dict[str, Any] | None = None) -> int:
        cleaned = name.strip()
        if not cleaned:
            raise GlpiClientError(f"Пустое имя для {itemtype}")
        cache_key = (itemtype, cleaned.casefold(), tuple(sorted((extra or {}).items())))
        cached = self._name_ids.get(cache_key)
        if cached is not None:
            return cached
        for row in self._search_named(itemtype, cleaned):
            row_name = (_as_text(row.get("name")) or "").casefold()
            if row_name != cleaned.casefold():
                continue
            if extra and not _extra_match(row, extra):
                continue
            found = _as_int(row.get("id"))
            if found is None:
                continue
            self._name_ids[cache_key] = found
            return found
        created = self._create_item(itemtype, {"name": cleaned[:255], **(extra or {})})
        self._name_ids[cache_key] = created
        return created

    def _search_named(self, itemtype: str, name: str) -> list[dict[str, Any]]:
        payload = self._read(
            f"{self.base}/apirest.php/{itemtype}",
            params={"searchText[name]": name, "range": "0-49"},
            headers={**self._asset_headers(), "Range": "items=0-49"},
        )
        if payload is None:
            return []
        return [row for row in _as_list(payload) if isinstance(row, dict)]

    def _create_item(self, itemtype: str, fields: dict[str, Any]) -> int:
        data = self._request(
            "POST",
            f"{self.base}/apirest.php/{itemtype}",
            headers=self._asset_headers(),
            json={"input": fields},
        )
        created = _id_from_payload(data)
        if created is None:
            raise GlpiClientError(f"GLPI не вернул id для {itemtype}")
        return created

    def _add_install(self, computer_id: int, version_id: int) -> None:
        self._request(
            "POST",
            f"{self.base}/apirest.php/Item_SoftwareVersion",
            headers=self._asset_headers(),
            json={
                "input": {
                    "itemtype": "Computer",
                    "items_id": computer_id,
                    "softwareversions_id": version_id,
                }
            },
        )

    def _delete_install(self, link_id: int) -> None:
        response = self._http.request(
            "DELETE",
            f"{self.base}/apirest.php/Item_SoftwareVersion/{link_id}",
            params={"force_purge": "true"},
            headers=self._asset_headers(),
        )
        self._parse(response)

    def _legacy_page(self, url: str, params: dict[str, Any] | None = None) -> list[object] | None:
        query = {"range": "0-199"}
        if params:
            query.update(params)
        payload = self._read(
            url,
            params=query,
            headers={**self._asset_headers(), "Range": "items=0-199"},
        )
        if payload is None:
            return None
        return _as_list(payload)

    def _read_item(self, itemtype: str, item_id: int) -> dict[str, Any] | None:
        payload = self._read(f"{self.base}/apirest.php/{itemtype}/{item_id}", headers=self._asset_headers())
        if isinstance(payload, dict):
            return payload
        return None

    def _read(
        self,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any | None:
        response = self._http.get(url, params=params, headers=headers or self._asset_headers())
        if response.status_code == 404:
            return None
        return self._parse(response, empty_on=(404,))

    def _asset_headers(self) -> dict[str, str]:
        if self.mode == "legacy" or not self._access:
            return self._legacy_headers()
        headers = {
            "Authorization": f"Bearer {self._access}",
            "Accept": "application/json",
        }
        app_token = (self.creds.app_token or "").strip()
        if app_token:
            headers["App-Token"] = app_token
        return headers

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
        version = _version_from(payload)
        identity = parse_glpi_identity(payload)
        if identity.username or identity.profile or identity.user_id:
            self._cached_identity = identity
        return version

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


def _outbound_body(item: GlpiOutbound, *, for_update: bool = False) -> dict[str, Any]:
    """Поля Ticket, общие для GLPI 10 (apirest) и GLPI 11 (api.php).

    Не шлём external_id — у стандартного Ticket такого поля нет.
    При UPDATE пустой текст CORAX не затирает content в GLPI.
    """
    priority = glpi_priority_id(item.priority)
    content = (item.content or "").rstrip()
    if item.corax_id > 0:
        marker = f"[CORAX #{item.corax_id}]"
        if content and marker not in content:
            content = f"{content}\n\n{marker}".strip()
        elif not content and not for_update:
            content = marker
    body: dict[str, Any] = {
        "name": (item.title or f"CORAX #{item.corax_id}")[:255],
        "status": glpi_status_id(item.status),
        "priority": priority,
        "urgency": priority,
        "impact": 3,
        "type": 1,
    }
    if content:
        body["content"] = content
    elif not for_update:
        body["content"] = ""
    return body


def _comment_with_ip(comment: str | None, ip_address: str | None) -> str | None:
    """Добавляет строку IP: … в комментарий ПК, не дублируя и не затирая текст."""
    base = (comment or "").rstrip()
    ip = (ip_address or "").strip()
    if not ip:
        return base or None
    marker = f"IP: {ip}"
    if marker in base:
        return base or None
    if not base:
        return marker
    return f"{base}\n{marker}"


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
        ("ERROR_RIGHT_MISSING", "У профиля GLPI нет прав на заявки (Ticket)."),
        ("ERROR_RIGHT", "У профиля GLPI нет прав на это действие с заявкой."),
        (
            "don't have permission",
            "Нет прав на это действие в GLPI. Профилю нужны CREATE/UPDATE на Ticket "
            "в нужной сущности. Если заявка CORAX уже связана с GLPI id — это UPDATE: "
            "выгрузите только новые без связи или выдайте права профилю.",
        ),
        ("ERROR_GLPI_ADD", "GLPI отказал в создании заявки (права или обязательные поля)."),
        ("ERROR_GLPI_UPDATE", "GLPI отказал в изменении заявки (права или сущность)."),
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


def parse_glpi_identity(payload: Any) -> GlpiIdentity:
    """Достаёт логин и активный профиль из getFullSession / User/Me."""
    if not isinstance(payload, dict):
        return GlpiIdentity()
    session = payload.get("session")
    root = session if isinstance(session, dict) else payload
    if not isinstance(root, dict):
        return GlpiIdentity()

    user_id = _as_int(root.get("glpiID") or root.get("id") or root.get("users_id"))
    username = _clip(
        root.get("glpiname")
        or root.get("name")
        or root.get("username")
        or root.get("user_name"),
        255,
    )
    first = _clip(root.get("glpifirstname") or root.get("firstname"), 128) or ""
    last = _clip(root.get("glpirealname") or root.get("realname") or root.get("lastname"), 128) or ""
    display = _clip(f"{first} {last}".strip() or root.get("displayname") or root.get("friendlyname"), 255)

    profile_raw = root.get("glpiactiveprofile") or root.get("active_profile") or root.get("profiles_id")
    profile = _field_name(profile_raw) or _clip(profile_raw, 255)
    if profile and profile.isdigit():
        profile = None

    entity = _clip(
        root.get("glpiactive_entity_name")
        or root.get("glpiactive_entity")
        or _field_name(root.get("entities_id")),
        255,
    )
    if entity and str(entity).isdigit():
        entity = None

    if not any((user_id, username, display, profile, entity)):
        return GlpiIdentity()
    return GlpiIdentity(
        user_id=user_id,
        username=username,
        display_name=display,
        profile=profile,
        entity=entity,
    )


def _identity_label(identity: GlpiIdentity | None, creds: GlpiCredentials) -> str:
    if identity:
        parts: list[str] = []
        if identity.display_name:
            parts.append(identity.display_name)
        if identity.username:
            parts.append(identity.username if not parts else f"({identity.username})")
        if identity.profile:
            parts.append(f"профиль «{identity.profile}»")
        if identity.entity:
            parts.append(f"сущность «{identity.entity}»")
        if parts:
            return " · ".join(parts)
    if (creds.username or "").strip() and creds.grant == "password":
        return (creds.username or "").strip()
    if creds.mode == "v2" and creds.grant == "client_credentials":
        return "OAuth client credentials"
    if (creds.user_token or "").strip():
        return "User-Token"
    return "текущая сессия GLPI"


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
    text = _as_text(value) if not isinstance(value, dict) else _field_name(value)
    if text is None:
        return None
    return text[:limit]


def _dropdown_label(value: object, limit: int = 255) -> str | None:
    return _clip(_field_name(value), limit)


def _extra_match(row: dict[str, Any], extra: dict[str, Any]) -> bool:
    for key, expected in extra.items():
        actual = row.get(key)
        if _as_int(actual) is not None and _as_int(actual) == _as_int(expected):
            continue
        if _as_text(actual) is not None and _as_text(actual) == _as_text(expected):
            continue
        return False
    return True
