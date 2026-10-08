"""Публичный поиск инструкций.

Этот модуль не читает WikiRAG, инвентарь и настройки парка.
В модель уходят только вопрос пользователя и текст открытых публичных страниц.
"""

from __future__ import annotations

import ipaddress
import re
from html.parser import HTMLParser
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import httpx

RESEARCH_SYSTEM = """Ты изолированный поиск по открытым страницам.
Тебе дают вопрос и выдержки с публичных сайтов. Базы CORAX, инвентаря и внутренних сетей у тебя нет.
Правила:
- Ответь по существу: что это за объект, как устроен, как настроить — только факты из выдержек.
- Пиши связный текст по-русски: кратко суть, затем детали, списки и команды как в источнике.
- Не выдумывай то, чего нет в выдержках, и не дополняй общей памятью модели.
- Не упоминай внутренние сети, инвентарь, хосты, пользователей, токены и базу CORAX.
- Если выдержек нет или в них нет ответа — скажи, что публичная инструкция не найдена.
- В конце перечисли URL, на которые опирался.
"""

RESEARCH_EMPTY = "Модель не сформулировала ответ по найденным страницам."

_STOPWORDS = {
    "как",
    "что",
    "это",
    "для",
    "или",
    "при",
    "без",
    "над",
    "под",
    "про",
    "чем",
    "где",
    "когда",
    "какой",
    "какая",
    "какие",
    "какой-то",
    "пожалуйста",
    "нужно",
    "надо",
    "можно",
    "мне",
    "есть",
    "такое",
    "такой",
    "the",
    "how",
    "what",
    "why",
    "and",
    "for",
    "with",
    "from",
    "that",
    "does",
    "can",
    "please",
    "a",
    "an",
    "to",
    "in",
    "on",
    "of",
}

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
_PAGE_CHARS = 3600
_TOTAL_CHARS = 12000
_FETCH_LIMIT = 8


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


def _tokens(text: str) -> list[str]:
    return [
        tok
        for tok in re.findall(r"[A-Za-zА-Яа-яЁё0-9\-]{3,}", (text or "").lower())
        if tok not in _STOPWORDS
    ]


def research_queries(question: str) -> list[str]:
    """Несколько публичных запросов вокруг объекта вопроса, без внутренних данных."""
    raw = " ".join((question or "").split())[:240]
    if len(raw) < 3:
        return []
    queries = [raw]
    core = " ".join(_tokens(raw)[:8]).strip()
    if core and core.lower() != raw.lower():
        queries.append(core)
    if core:
        queries.append(f"{core} wikipedia")
    seen: set[str] = set()
    out: list[str] = []
    for item in queries:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out[:3]


def page_relevance(question: str, page: dict[str, str]) -> int:
    terms = _tokens(question)
    if not terms:
        return 0
    blob = " ".join(
        [
            page.get("title") or "",
            page.get("snippet") or "",
            page.get("text") or "",
            page.get("url") or "",
        ]
    ).lower()
    return sum(1 for term in terms if term in blob)


def fallback_answer_from_pages(pages: list[dict[str, str]]) -> str:
    """Если модель молчит — показать выдержки со страниц, не трогая базу CORAX."""
    usable = [p for p in pages if (p.get("text") or p.get("snippet") or "").strip()]
    if not usable:
        return ""
    blocks = [
        "Публичные источники нашлись, но модель не сформулировала текст. Кратко по открытым страницам:"
    ]
    for index, page in enumerate(usable[:5], start=1):
        title = (page.get("title") or page.get("url") or "страница").strip()
        body = (page.get("text") or page.get("snippet") or "").strip()[:520]
        url = (page.get("url") or "").strip()
        blocks.append(f"{index}. {title}\n{body}" + (f"\n{url}" if url else ""))
    return "\n\n".join(blocks)


def research_parsed_answer(raw: str, pages: list[dict[str, str]]) -> dict:
    from app.wikirag_lm import coerce_parsed

    parsed = coerce_parsed(raw or "")
    answer = str(parsed.get("answer") or "").strip()
    if (not (raw or "").strip()) or answer.startswith("Модель не вернула текст") or answer == RESEARCH_EMPTY:
        fallback = fallback_answer_from_pages(pages)
        parsed["answer"] = fallback or RESEARCH_EMPTY
    return parsed


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


def _wiki_langs(question: str) -> tuple[str, ...]:
    if re.search(r"[а-яё]", (question or "").lower()):
        return ("ru", "en")
    return ("en", "ru")


async def _wikipedia_hits(client: httpx.AsyncClient, question: str, *, limit: int = 3) -> list[dict[str, str]]:
    core = " ".join(_tokens(question)[:8]) or " ".join((question or "").split())[:80]
    if len(core) < 3:
        return []
    hits: list[dict[str, str]] = []
    seen: set[str] = set()
    for lang in _wiki_langs(question):
        api = f"https://{lang}.wikipedia.org/w/api.php"
        if not public_url_allowed(api):
            continue
        try:
            response = await client.get(
                api,
                params={
                    "action": "opensearch",
                    "search": core,
                    "limit": str(limit),
                    "namespace": "0",
                    "format": "json",
                },
            )
        except httpx.HTTPError:
            continue
        if response.status_code != 200:
            continue
        try:
            data = response.json()
        except ValueError:
            continue
        if not isinstance(data, list) or len(data) < 4:
            continue
        titles = data[1] if isinstance(data[1], list) else []
        snippets = data[2] if isinstance(data[2], list) else []
        urls = data[3] if isinstance(data[3], list) else []
        for index, url in enumerate(urls):
            href = str(url or "").strip()
            if not href or href in seen or not public_url_allowed(href):
                continue
            seen.add(href)
            title = str(titles[index] if index < len(titles) else href)
            snippet = str(snippets[index] if index < len(snippets) else "")
            hits.append({"title": title[:180] or href, "url": href, "snippet": snippet[:400]})
            if len(hits) >= limit * 2:
                return hits
    return hits


async def _wikipedia_extract(client: httpx.AsyncClient, url: str) -> str:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host.endswith("wikipedia.org"):
        return ""
    title = unquote(parsed.path.split("/wiki/")[-1]) if "/wiki/" in parsed.path else ""
    if not title:
        return ""
    api = f"{parsed.scheme}://{host}/w/api.php"
    if not public_url_allowed(api):
        return ""
    try:
        response = await client.get(
            api,
            params={
                "action": "query",
                "prop": "extracts",
                "explaintext": "1",
                "exchars": str(_PAGE_CHARS),
                "redirects": "1",
                "titles": title.replace("_", " "),
                "format": "json",
            },
        )
    except httpx.HTTPError:
        return ""
    if response.status_code != 200:
        return ""
    try:
        data = response.json()
    except ValueError:
        return ""
    pages = (((data or {}).get("query") or {}).get("pages") or {})
    if not isinstance(pages, dict):
        return ""
    for item in pages.values():
        if isinstance(item, dict):
            extract = str(item.get("extract") or "").strip()
            if extract:
                return extract[:_PAGE_CHARS]
    return ""


async def iterate_public_research(question: str, *, limit: int = 6):
    """Ищет публичные страницы и сообщает шаги. Базу CORAX не читает."""
    queries = research_queries(question)
    if not queries:
        yield ("pages", [])
        return
    timeout = httpx.Timeout(12.0, connect=5.0)
    headers = {"User-Agent": _UA, "Accept": "text/html,text/plain,application/json"}
    pages: list[dict[str, str]] = []
    seen: set[str] = set()
    async with httpx.AsyncClient(timeout=timeout, headers=headers, follow_redirects=False) as client:
        yield (
            "progress",
            {
                "stage": "search",
                "label": "Ищет публичные источники…",
                "query": queries[0],
            },
        )
        wiki_hits = await _wikipedia_hits(client, question, limit=3)
        ddg_hits: list[dict[str, str]] = []
        for query in queries:
            yield (
                "progress",
                {
                    "stage": "search",
                    "label": f"Ищет: {query}",
                    "query": query,
                },
            )
            try:
                found = await client.post(
                    _SEARCH_URL,
                    data={"q": query, "kl": "ru-ru" if re.search(r"[а-яё]", query.lower()) else "wt-wt"},
                )
                html = found.text if found.status_code == 200 else ""
            except httpx.HTTPError:
                html = ""
            for hit in parse_search_results(html, limit=limit):
                if hit["url"] in seen:
                    continue
                ddg_hits.append(hit)
        hits: list[dict[str, str]] = []
        for hit in [*wiki_hits, *ddg_hits]:
            url = hit.get("url") or ""
            if not url or url in seen or not public_url_allowed(url):
                continue
            seen.add(url)
            hits.append(hit)
            if len(hits) >= _FETCH_LIMIT:
                break
        yield (
            "progress",
            {
                "stage": "found",
                "label": f"Нашёл {len(hits)} источников" if hits else "Публичные страницы не нашлись",
                "found": len(hits),
            },
        )
        for index, hit in enumerate(hits, start=1):
            yield (
                "progress",
                {
                    "stage": "open",
                    "label": f"Читает: {hit.get('title') or hit.get('url')}",
                    "title": hit.get("title") or "",
                    "url": hit.get("url") or "",
                    "index": index,
                    "total": len(hits),
                },
            )
            text = ""
            try:
                text = await _wikipedia_extract(client, hit["url"])
                if not text:
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
        pages.sort(key=lambda page: page_relevance(question, page), reverse=True)
        pages = pages[:limit]
        yield (
            "progress",
            {
                "stage": "ready",
                "label": f"Открыто страниц: {len(pages)}" if pages else "Не удалось открыть страницы",
                "pages": len(pages),
                "titles": [p.get("title") or p.get("url") or "" for p in pages[:6]],
            },
        )
        yield ("pages", pages)


async def collect_public_pages(question: str, *, limit: int = 6) -> list[dict[str, str]]:
    pages: list[dict[str, str]] = []
    async for kind, payload in iterate_public_research(question, limit=limit):
        if kind == "pages":
            pages = payload
    return pages
