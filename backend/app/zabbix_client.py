"""Read-only Zabbix JSON-RPC client (scope A: connection smoke + light samples)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

AuthMode = Literal["bearer", "body", "both"]


class ZabbixClientError(Exception):
    """User-facing Zabbix API failure."""


@dataclass(frozen=True)
class ZabbixProbeResult:
    ok: bool
    version: str | None
    hosts_total: int | None
    problems_total: int | None
    message: str
    api_url: str = ""
    auth_mode: str = ""
    scheme: str = ""  # http | https
    sample_hosts: list[str] = field(default_factory=list)
    sample_problems: list[str] = field(default_factory=list)


def _normalize_api_url(base_url: str) -> str:
    raw = (base_url or "").strip().rstrip("/")
    if not raw:
        raise ZabbixClientError("Укажите URL Zabbix")
    # Allow LAN hosts without scheme — default to http (typical office Zabbix).
    if not (raw.startswith("http://") or raw.startswith("https://")):
        if re.match(r"^[a-zA-Z0-9.-]+(:\d+)?(/.*)?$", raw):
            raw = f"http://{raw}"
        else:
            raise ZabbixClientError("URL должен начинаться с http:// или https://")
    if raw.endswith("/api_jsonrpc.php"):
        return raw
    return f"{raw}/api_jsonrpc.php"


def _parse_version(version: str | None) -> tuple[int, int]:
    if not version:
        return (0, 0)
    m = re.match(r"(\d+)\.(\d+)", str(version).strip())
    if not m:
        return (0, 0)
    return int(m.group(1)), int(m.group(2))


def _auth_modes_for_version(version: str | None) -> list[AuthMode]:
    """Zabbix 7+ prefers Bearer; 5.4–6.x usually want auth in JSON body."""
    major, _minor = _parse_version(version)
    if major >= 7:
        return ["bearer", "body", "both"]
    if major >= 5:
        return ["body", "bearer", "both"]
    return ["body", "both", "bearer"]


def _friendly_auth_error(raw: str, *, scheme: str) -> str:
    low = (raw or "").lower()
    if any(x in low for x in ("not authorized", "session terminated", "invalid auth", "no auth", "unauthorized")):
        hint_http = ""
        if scheme == "http":
            hint_http = (
                " URL по HTTP в LAN — нормально; запрос идёт с сервера CORAX, не из браузера."
            )
        return (
            "Авторизация отклонена Zabbix. Проверьте API token (Users → API tokens), "
            "что токен не истёк и у него есть права на host.get / problem.get."
            + hint_http
            + f" Ответ API: {raw}"
        )
    # Не клеим HTTP/CORS-подсказки к ошибкам параметров API — это путает.
    return raw


def _rpc(
    api_url: str,
    *,
    method: str,
    params: Any,
    token: str | None,
    auth_mode: AuthMode | None,
    timeout: float,
    verify_tls: bool,
    req_id: int = 1,
) -> Any:
    payload: dict[str, Any] = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": req_id,
    }
    headers = {
        "Content-Type": "application/json-rpc",
        "Accept": "application/json",
        "User-Agent": "CORAX-Zabbix/1.0",
    }
    tok = (token or "").strip()
    if tok and auth_mode in ("body", "both"):
        payload["auth"] = tok
    if tok and auth_mode in ("bearer", "both"):
        headers["Authorization"] = f"Bearer {tok}"

    body = json.dumps(payload).encode("utf-8")

    import ssl

    ctx = None
    if api_url.startswith("https://"):
        if not verify_tls:
            ctx = ssl._create_unverified_context()  # noqa: S323 — admin opt-in for lab certs
    # http:// — no TLS context; verify_tls flag is ignored (correct for plain HTTP LAN).

    req = Request(api_url, data=body, headers=headers, method="POST")
    try:
        with urlopen(req, timeout=timeout, context=ctx) as resp:  # noqa: S310
            raw = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:240]
        except Exception:
            detail = ""
        msg = f"HTTP {exc.code} от Zabbix"
        if detail:
            msg = f"{msg}: {detail}"
        if exc.code in (401, 403):
            raise ZabbixClientError(
                f"{msg}. Если Zabbix на HTTP — убедитесь, что URL именно http://… "
                "и токен создан в UI Zabbix (не пароль пользователя)."
            ) from exc
        raise ZabbixClientError(msg) from exc
    except URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise ZabbixClientError(
            f"Сеть: {reason}. Из Docker-контейнера должен быть доступен IP/DNS Zabbix "
            "(часто это адрес LAN, не localhost контейнера)."
        ) from exc
    except TimeoutError as exc:
        raise ZabbixClientError("Таймаут ответа Zabbix") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        snippet = raw.strip().replace("\n", " ")[:160]
        raise ZabbixClientError(
            f"Zabbix вернул не-JSON (часто HTML логина). Проверьте URL до /api_jsonrpc.php. Ответ: {snippet}"
        ) from exc
    if not isinstance(data, dict):
        raise ZabbixClientError("Некорректный JSON-RPC ответ")
    if data.get("error"):
        err = data["error"]
        if isinstance(err, dict):
            msg = str(err.get("data") or err.get("message") or err)
        else:
            msg = str(err)
        scheme = "https" if api_url.startswith("https://") else "http"
        raise ZabbixClientError(_friendly_auth_error(msg, scheme=scheme))
    return data.get("result")


def _rpc_authed(
    api_url: str,
    *,
    method: str,
    params: Any,
    token: str,
    preferred_modes: list[AuthMode],
    timeout: float,
    verify_tls: bool,
    req_id: int,
) -> tuple[Any, AuthMode]:
    errors: list[str] = []
    for mode in preferred_modes:
        try:
            result = _rpc(
                api_url,
                method=method,
                params=params,
                token=token,
                auth_mode=mode,
                timeout=timeout,
                verify_tls=verify_tls,
                req_id=req_id,
            )
            return result, mode
        except ZabbixClientError as exc:
            errors.append(f"{mode}: {exc}")
            continue
    raise ZabbixClientError("Не удалось авторизоваться. " + " | ".join(errors[-3:]))


def probe_zabbix(
    *,
    base_url: str,
    api_token: str,
    verify_tls: bool = True,
    timeout: float = 12.0,
) -> ZabbixProbeResult:
    """apiinfo.version + counts + sample host/problem names for UI preview."""
    api_url = _normalize_api_url(base_url)
    scheme = "https" if api_url.startswith("https://") else "http"
    token = (api_token or "").strip()
    if not token:
        raise ZabbixClientError("Укажите API token Zabbix")

    # For plain HTTP, TLS verify is irrelevant — never fail on that path.
    effective_verify = verify_tls if scheme == "https" else False

    version = _rpc(
        api_url,
        method="apiinfo.version",
        params=[],
        token=None,
        auth_mode=None,
        timeout=timeout,
        verify_tls=effective_verify,
        req_id=1,
    )
    version_s = str(version) if version is not None else None
    modes = _auth_modes_for_version(version_s)

    hosts, mode = _rpc_authed(
        api_url,
        method="host.get",
        params={"countOutput": True},
        token=token,
        preferred_modes=modes,
        timeout=timeout,
        verify_tls=effective_verify,
        req_id=2,
    )
    # Stick to the mode that worked for the rest of the probe.
    preferred = [mode] + [m for m in modes if m != mode]

    problems, _mode2 = _rpc_authed(
        api_url,
        method="problem.get",
        params={"countOutput": True, "recent": False},
        token=token,
        preferred_modes=preferred,
        timeout=timeout,
        verify_tls=effective_verify,
        req_id=3,
    )

    sample_hosts: list[str] = []
    sample_problems: list[str] = []
    try:
        host_rows, _ = _rpc_authed(
            api_url,
            method="host.get",
            params={"output": ["host", "name"], "limit": 5, "sortfield": "name", "sortorder": "ASC"},
            token=token,
            preferred_modes=preferred,
            timeout=timeout,
            verify_tls=effective_verify,
            req_id=4,
        )
        if isinstance(host_rows, list):
            for row in host_rows:
                if not isinstance(row, dict):
                    continue
                label = (row.get("name") or row.get("host") or "").strip()
                if label:
                    sample_hosts.append(label)
    except ZabbixClientError:
        pass

    try:
        problem_rows, _ = _rpc_authed(
            api_url,
            method="problem.get",
            params={"output": ["name", "severity"], "recent": False, "sortfield": "eventid", "sortorder": "DESC", "limit": 5},
            token=token,
            preferred_modes=preferred,
            timeout=timeout,
            verify_tls=effective_verify,
            req_id=5,
        )
        if isinstance(problem_rows, list):
            for row in problem_rows:
                if not isinstance(row, dict):
                    continue
                label = (row.get("name") or "").strip()
                if label:
                    sample_problems.append(label)
    except ZabbixClientError:
        pass

    try:
        hosts_n = int(hosts)
    except (TypeError, ValueError):
        hosts_n = None
    try:
        problems_n = int(problems)
    except (TypeError, ValueError):
        problems_n = None

    parts = [
        f"Zabbix {version_s or '?'}",
        f"{scheme.upper()}",
        f"auth={mode}",
        f"хостов: {hosts_n if hosts_n is not None else '?'}",
    ]
    if problems_n is not None:
        parts.append(f"проблем: {problems_n}")
    return ZabbixProbeResult(
        ok=True,
        version=version_s,
        hosts_total=hosts_n,
        problems_total=problems_n,
        message="; ".join(parts),
        api_url=api_url,
        auth_mode=mode,
        scheme=scheme,
        sample_hosts=sample_hosts,
        sample_problems=sample_problems,
    )


def ui_base_url(base_url: str) -> str:
    """Public UI root (without /api_jsonrpc.php)."""
    raw = (base_url or "").strip().rstrip("/")
    if raw.endswith("/api_jsonrpc.php"):
        raw = raw[: -len("/api_jsonrpc.php")].rstrip("/")
    return raw


def hostname_match_keys(hostname: str) -> list[str]:
    """Candidates for CORAX hostname ↔ Zabbix host/name (preserve case variants)."""
    raw = (hostname or "").strip()
    if not raw:
        return []
    keys: list[str] = []
    seen: set[str] = set()

    def add(v: str) -> None:
        v = v.strip().rstrip(".")
        if not v or v in seen:
            return
        seen.add(v)
        keys.append(v)

    add(raw)
    add(raw.lower())
    add(raw.upper())
    short = raw.split(".", 1)[0]
    add(short)
    add(short.lower())
    add(short.upper())
    return keys


def _norm_key(v: str) -> str:
    return (v or "").strip().lower().rstrip(".")


@dataclass
class ZabbixSession:
    """Reusable read-only JSON-RPC session (auth mode pinned after connect)."""

    api_url: str
    token: str
    verify_tls: bool
    auth_mode: AuthMode
    version: str | None
    scheme: str
    timeout: float = 12.0
    _req_id: int = 10

    def call(self, method: str, params: Any) -> Any:
        self._req_id += 1
        return _rpc(
            self.api_url,
            method=method,
            params=params,
            token=self.token,
            auth_mode=self.auth_mode,
            timeout=self.timeout,
            verify_tls=self.verify_tls,
            req_id=self._req_id,
        )


def open_zabbix_session(
    *,
    base_url: str,
    api_token: str,
    verify_tls: bool = True,
    timeout: float = 12.0,
) -> ZabbixSession:
    api_url = _normalize_api_url(base_url)
    scheme = "https" if api_url.startswith("https://") else "http"
    token = (api_token or "").strip()
    if not token:
        raise ZabbixClientError("Укажите API token Zabbix")
    effective_verify = verify_tls if scheme == "https" else False

    version = _rpc(
        api_url,
        method="apiinfo.version",
        params=[],
        token=None,
        auth_mode=None,
        timeout=timeout,
        verify_tls=effective_verify,
        req_id=1,
    )
    version_s = str(version) if version is not None else None
    modes = _auth_modes_for_version(version_s)
    _, mode = _rpc_authed(
        api_url,
        method="host.get",
        params={"countOutput": True},
        token=token,
        preferred_modes=modes,
        timeout=timeout,
        verify_tls=effective_verify,
        req_id=2,
    )
    return ZabbixSession(
        api_url=api_url,
        token=token,
        verify_tls=effective_verify,
        auth_mode=mode,
        version=version_s,
        scheme=scheme,
        timeout=timeout,
    )


def _as_int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _severity_label(sev: int | None) -> str:
    labels = {
        0: "не классифицировано",
        1: "информация",
        2: "предупреждение",
        3: "средняя",
        4: "высокая",
        5: "катастрофа",
    }
    if sev is None:
        return "—"
    return labels.get(sev, str(sev))


def fetch_problem_rows(session: ZabbixSession, *, limit: int = 50, hostids: list[str] | None = None) -> list[dict[str, Any]]:
    """problem.get without selectHosts (unsupported on older Zabbix); hosts via trigger.get."""
    lim = max(1, min(int(limit), 200))
    params: dict[str, Any] = {
        "output": ["eventid", "name", "severity", "clock", "objectid"],
        "recent": False,
        "sortfield": "eventid",
        "sortorder": "DESC",
        "limit": lim,
    }
    if hostids:
        params["hostids"] = hostids
    rows = session.call("problem.get", params)
    if not isinstance(rows, list):
        return []

    trigger_ids: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        oid = str(row.get("objectid") or "").strip()
        if oid and oid not in trigger_ids:
            trigger_ids.append(oid)

    hosts_by_trigger: dict[str, list[str]] = {}
    if trigger_ids:
        try:
            triggers = session.call(
                "trigger.get",
                {
                    "triggerids": trigger_ids,
                    "output": ["triggerid"],
                    "selectHosts": ["hostid", "host", "name"],
                },
            )
            if isinstance(triggers, list):
                for tr in triggers:
                    if not isinstance(tr, dict):
                        continue
                    tid = str(tr.get("triggerid") or "")
                    names: list[str] = []
                    for h in tr.get("hosts") if isinstance(tr.get("hosts"), list) else []:
                        if not isinstance(h, dict):
                            continue
                        label = (h.get("name") or h.get("host") or "").strip()
                        if label:
                            names.append(label)
                    if tid and names:
                        hosts_by_trigger[tid] = names
        except ZabbixClientError:
            hosts_by_trigger = {}

    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        oid = str(row.get("objectid") or "")
        sev = _as_int(row.get("severity"))
        clock = _as_int(row.get("clock"))
        out.append(
            {
                "eventid": str(row.get("eventid") or ""),
                "name": (row.get("name") or "").strip(),
                "severity": sev if sev is not None else 0,
                "severity_label": _severity_label(sev),
                "clock": clock,
                "hosts": list(hosts_by_trigger.get(oid) or []),
            }
        )
    return out


def fetch_host_rows(session: ZabbixSession, *, limit: int = 100) -> list[dict[str, Any]]:
    lim = max(1, min(int(limit), 500))
    rows = session.call(
        "host.get",
        {
            "output": ["hostid", "host", "name", "status"],
            "selectInterfaces": ["ip", "dns", "main", "type"],
            "limit": lim,
            "sortfield": "name",
            "sortorder": "ASC",
        },
    )
    if not isinstance(rows, list):
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        ip = ""
        ifaces = row.get("interfaces") if isinstance(row.get("interfaces"), list) else []
        for iface in ifaces:
            if not isinstance(iface, dict):
                continue
            if str(iface.get("main") or "") == "1" and (iface.get("ip") or "").strip():
                ip = str(iface.get("ip")).strip()
                break
        if not ip:
            for iface in ifaces:
                if isinstance(iface, dict) and (iface.get("ip") or "").strip():
                    ip = str(iface.get("ip")).strip()
                    break
        status = _as_int(row.get("status"))
        out.append(
            {
                "hostid": str(row.get("hostid") or ""),
                "host": (row.get("host") or "").strip(),
                "name": (row.get("name") or "").strip(),
                "status": status if status is not None else 0,
                "ip": ip,
            }
        )
    return out


def find_host_by_hostname(session: ZabbixSession, hostname: str) -> dict[str, Any] | None:
    keys = hostname_match_keys(hostname)
    if not keys:
        return None
    key_set = {_norm_key(k) for k in keys}
    # Prefer exact filter on technical host name, then visible name.
    for field in ("host", "name"):
        for key in keys:
            rows = session.call(
                "host.get",
                {
                    "output": ["hostid", "host", "name", "status"],
                    "selectInterfaces": ["ip", "dns", "main"],
                    "filter": {field: [key]},
                    "limit": 5,
                },
            )
            if isinstance(rows, list) and rows:
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    cand = _norm_key(str(row.get(field) or ""))
                    if cand in key_set:
                        return _normalize_host_row(row)
                if isinstance(rows[0], dict):
                    return _normalize_host_row(rows[0])
    # Fuzzy search fallback (substring) — only accept if short-name equals.
    short = _norm_key(keys[0]).split(".", 1)[0]
    rows = session.call(
        "host.get",
        {
            "output": ["hostid", "host", "name", "status"],
            "selectInterfaces": ["ip", "dns", "main"],
            "search": {"host": short, "name": short},
            "searchByAny": True,
            "limit": 20,
        },
    )
    if not isinstance(rows, list):
        return None
    for row in rows:
        if not isinstance(row, dict):
            continue
        host_v = _norm_key(str(row.get("host") or ""))
        name_v = _norm_key(str(row.get("name") or ""))
        host_short = host_v.split(".", 1)[0]
        name_short = name_v.split(".", 1)[0]
        if host_v in key_set or name_v in key_set or host_short == short or name_short == short:
            return _normalize_host_row(row)
    return None


def _normalize_host_row(row: dict[str, Any]) -> dict[str, Any]:
    ip = ""
    ifaces = row.get("interfaces") if isinstance(row.get("interfaces"), list) else []
    for iface in ifaces:
        if not isinstance(iface, dict):
            continue
        if str(iface.get("main") or "") == "1" and (iface.get("ip") or "").strip():
            ip = str(iface.get("ip")).strip()
            break
    if not ip:
        for iface in ifaces:
            if isinstance(iface, dict) and (iface.get("ip") or "").strip():
                ip = str(iface.get("ip")).strip()
                break
    status = _as_int(row.get("status"))
    return {
        "hostid": str(row.get("hostid") or ""),
        "host": (row.get("host") or "").strip(),
        "name": (row.get("name") or "").strip(),
        "status": status if status is not None else 0,
        "ip": ip,
    }


def fetch_overview(session: ZabbixSession, *, problem_limit: int = 12) -> dict[str, Any]:
    hosts_total = _as_int(session.call("host.get", {"countOutput": True}))
    problems_total = _as_int(session.call("problem.get", {"countOutput": True, "recent": False}))
    problems = fetch_problem_rows(session, limit=problem_limit)
    by_sev: dict[str, int] = {str(i): 0 for i in range(6)}
    for p in problems:
        k = str(int(p.get("severity") or 0))
        if k in by_sev:
            by_sev[k] += 1
    return {
        "version": session.version,
        "hosts_total": hosts_total,
        "problems_total": problems_total,
        "problems": problems,
        "severity_sample": by_sev,
        "scheme": session.scheme,
        "auth_mode": session.auth_mode,
    }


def build_zabbix_wiki_markdown(
    *,
    enabled: bool,
    base_url: str,
    version: str | None,
    hosts_total: int | None,
    problems_total: int | None,
    last_ok: bool | None,
    last_message: str | None,
    sample_hosts: list[str] | None = None,
    sample_problems: list[str] | None = None,
) -> str | None:
    """Markdown snapshot for WikiRAG CORAX export."""
    if not enabled:
        return None
    url = (base_url or "").strip()
    if not url:
        return None
    lines = [
        "# Zabbix (CORAX интеграция)",
        "",
        "Снимок интеграции CORAX ↔ Zabbix (только чтение API). Сопоставление ПК: hostname CORAX ↔ host/name Zabbix.",
        "",
        f"- **URL:** `{url}`",
        f"- **Версия API:** {version or '—'}",
        f"- **Хостов:** {hosts_total if hosts_total is not None else '—'}",
        f"- **Открытых проблем:** {problems_total if problems_total is not None else '—'}",
        f"- **Последняя проверка:** {'OK' if last_ok else 'ошибка' if last_ok is False else 'ещё не запускалась'}",
    ]
    if last_message:
        lines.append(f"- **Детали:** {last_message}")
    if sample_hosts:
        lines.extend(["", "## Примеры хостов", ""])
        for name in sample_hosts[:15]:
            lines.append(f"- {name}")
    if sample_problems:
        lines.extend(["", "## Открытые проблемы (фрагмент)", ""])
        for name in sample_problems[:20]:
            lines.append(f"- {name}")
    lines.append("")
    return "\n".join(lines)
