"""Публичный поиск инструкций.

Этот модуль не читает WikiRAG, инвентарь и настройки парка.
В модель уходят только вопрос пользователя и текст открытых публичных страниц.
"""

from __future__ import annotations

import ipaddress
import re
from html.parser import HTMLParser
from urllib.parse import parse_qs, urljoin, urlparse

import httpx

RESEARCH_SYSTEM = """Ты изолированный поиск публичных инструкций.
Тебе дают вопрос и выдержки с открытых сайтов. Других знаний у тебя в этом режиме нет.
Правила:
- Пиши шаги только если они есть в выдержках. Команды копируй как в источнике.
- Не дополняй ответ памятью модели, догадками и общими советами.
- Не упоминай внутренние сети, инвентарь, хосты, пользователей, токены и базу CORAX.
- Если выдержек нет или в них нет ответа — скажи, что публичная инструкция не найдена.
- Язык ответа — русский. В конце перечисли URL, на которые опирался.
"""

_UA = "CORAX-Research/1.0"
_SEARCH_URL = "https://html.duckduckgo.com/html/"
_RESULT_RE = re.compile(
    r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_SNIPPET_RE = re.compile(
    r'class="result__snippet"[^>]*>(.*?)</(?:a|td|span|div)',
    re.IGNORECASE | re.DOTALL,
)
_TAG_RE = re.compile(r"<[^>]+>")
_SKIP_HOST_SUFFIXES = (".local", ".internal", ".lan", ".home", ".corp", ".localdomain")
_PAGE_CHARS = 3200
_TOTAL_CHARS = 9000


def _ip_is_public(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return bool(addr.is_global)


def host_is_public(host: str) -> bool:
    name = (host or "").strip().rstrip(".").lower()
    if not name or name in {"localhost", "metadata.google.internal"}:
        return False
    if name.endswith(_SKIP_HOST_SUFFIXES):
        return False
    try:
        ipaddress.ip_address(name)
        return _ip_is_public(name)
    except ValueError:
        pass
    try:
        infos = socket_getaddrinfo(name)
    except OSError:
        return False
    ips = [item[4][0] for item in infos if item and item[4]]
    if not ips:
        return False
    return all(_ip_is_public(ip) for ip in ips)


def socket_getaddrinfo(host: str):
    import socket

    return socket.getaddrinfo(host, None)


def public_url_allowed(url: str) -> bool:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in {"http", "https"}:
        return False
    if parsed.username or parsed.password:
        return False
    if parsed.port not in {None, 80, 443}:
        return False
    host = parsed.hostname or ""
    if not host:
        return False
    return host_is_public(host)


def unwrap_search_href(href: str) -> str:
    raw = (href or "").strip()
    if raw.startswith("//"):
        raw = "https:" + raw
    parsed = urlparse(raw)
    if "uddg" in parse_qs(parsed.query):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        return target.strip()
    return raw


def _strip_tags(value: str) -> str:
    text = _TAG_RE.sub(" ", value or "")
    return re.sub(r"\s+", " ", text).strip()


class _VisibleText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._skip:
            self._skip -= 1

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        chunk = data.strip()
        if chunk:
            self.parts.append(chunk)


def html_to_text(raw: str, *, limit: int = _PAGE_CHARS) -> str:
    parser = _VisibleText()
    try:
        parser.feed(raw or "")
        parser.close()
    except Exception:
        return _strip_tags(raw)[:limit]
    text = re.sub(r"\s+", " ", " ".join(parser.parts)).strip()
    return text[:limit]


def parse_search_results(html: str, *, limit: int = 4) -> list[dict[str, str]]:
    links = _RESULT_RE.findall(html or "")
    snippets = _SNIPPET_RE.findall(html or "")
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, (href, title_html) in enumerate(links):
        url = unwrap_search_href(href)
        if not url.startswith("http") or url in seen:
            continue
        if not public_url_allowed(url):
            continue
        seen.add(url)
        snippet = _strip_tags(snippets[index]) if index < len(snippets) else ""
        out.append({"title": _strip_tags(title_html)[:180] or url, "url": url, "snippet": snippet[:400]})
        if len(out) >= limit:
            break
    return out


def build_research_messages(
    question: str,
    pages: list[dict[str, str]],
    history: list[dict[str, str]] | None = None,
) -> list[dict[str, str]]:
    """Сообщение модели: вопрос и публичные страницы. Внутренних данных нет."""
    blocks: list[str] = []
    used = 0
    for index, page in enumerate(pages, start=1):
        body = (page.get("text") or page.get("snippet") or "").strip()
        if used >= _TOTAL_CHARS:
            break
        body = body[: max(0, _TOTAL_CHARS - used)]
        used += len(body)
        title = (page.get("title") or page.get("url") or "страница").strip()
        url = (page.get("url") or "").strip()
        blocks.append(f"[{index}] {title}\nURL: {url}\n{body}")
    context = "\n\n".join(blocks) if blocks else "(публичные страницы не открылись)"
    messages: list[dict[str, str]] = [{"role": "system", "content": RESEARCH_SYSTEM}]
    for item in (history or [])[-2:]:
        role = item.get("role")
        content = (item.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content[:1500]})
    messages.append(
        {
            "role": "user",
            "content": (
                f"Вопрос:\n{question.strip()[:2000]}\n\n"
                f"Публичные страницы:\n{context}"
            ),
        }
    )
    return messages


def research_sources(pages: list[dict[str, str]]) -> list[dict[str, str | int]]:
    sources: list[dict[str, str | int]] = []
    for page in pages:
        url = (page.get("url") or "").strip()
        if not url:
            continue
        sources.append(
            {
                "kind": "web",
                "document_id": 0,
                "filename": url,
                "label": (page.get("title") or url)[:180],
                "excerpt": (page.get("text") or page.get("snippet") or "")[:280],
            }
        )
    return sources


async def _fetch_public(client: httpx.AsyncClient, url: str) -> str:
    current = url
    for _ in range(3):
        if not public_url_allowed(current):
            return ""
        response = await client.get(current, follow_redirects=False)
        if response.status_code in {301, 302, 303, 307, 308}:
            loc = response.headers.get("location") or ""
            current = urljoin(current, loc)
            continue
        if response.status_code != 200:
            return ""
        ctype = (response.headers.get("content-type") or "").lower()
        if "html" not in ctype and "text/plain" not in ctype:
            return ""
        return html_to_text(response.text)
    return ""


async def collect_public_pages(question: str, *, limit: int = 4) -> list[dict[str, str]]:
    query = " ".join((question or "").split())[:240]
    if len(query) < 3:
        return []
    timeout = httpx.Timeout(12.0, connect=5.0)
    headers = {"User-Agent": _UA, "Accept": "text/html,text/plain"}
    async with httpx.AsyncClient(timeout=timeout, headers=headers, follow_redirects=False) as client:
        try:
            found = await client.post(_SEARCH_URL, data={"q": query})
            html = found.text if found.status_code == 200 else ""
        except httpx.HTTPError:
            return []
        hits = parse_search_results(html, limit=limit)
        pages: list[dict[str, str]] = []
        for hit in hits:
            text = ""
            try:
                text = await _fetch_public(client, hit["url"])
            except httpx.HTTPError:
                text = ""
            pages.append(
                {
                    "title": hit["title"],
                    "url": hit["url"],
                    "snippet": hit.get("snippet") or "",
                    "text": text or hit.get("snippet") or "",
                }
            )
        return pages
