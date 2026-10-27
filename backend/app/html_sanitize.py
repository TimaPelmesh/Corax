"""Whitelist HTML sanitizer for shared notes (no script/iframe/event handlers)."""

from __future__ import annotations

import re
from html.parser import HTMLParser

_ALLOWED = frozenset(
    {
        "p",
        "br",
        "b",
        "i",
        "u",
        "s",
        "strong",
        "em",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "blockquote",
        "code",
        "pre",
        "span",
        "div",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "a",
        "hr",
    }
)
_VOID = frozenset({"br", "hr"})
_SAFE_HREF = re.compile(r"^(https?:|mailto:|/|#)", re.IGNORECASE)
_ATTR_OK = {"a": frozenset({"href", "title"}), "td": frozenset({"colspan", "rowspan"}), "th": frozenset({"colspan", "rowspan"})}


def _escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._out: list[str] = []
        self._skip = 0
        self._span_extra: list[list[str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t in {"script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button", "svg"}:
            self._skip += 1
            return
        if self._skip or t not in _ALLOWED:
            return
        if t == "span":
            style = ""
            for name, value in attrs:
                if (name or "").lower() == "style":
                    style = (value or "").lower()
                    break
            extra: list[str] = []
            if re.search(r"font-weight\s*:\s*(bold|[6-9]00|bolder)", style):
                extra.append("strong")
            if re.search(r"font-style\s*:\s*italic", style):
                extra.append("em")
            self._out.append("<span>")
            for e in extra:
                self._out.append(f"<{e}>")
            self._span_extra.append(extra)
            return
        allowed_attrs = _ATTR_OK.get(t, frozenset())
        bits = [t]
        for name, value in attrs:
            n = (name or "").lower()
            if n.startswith("on") or n in {"style", "src", "srcset"}:
                continue
            if n not in allowed_attrs:
                continue
            val = (value or "").strip()
            if n == "href" and not _SAFE_HREF.match(val):
                continue
            bits.append(f'{n}="{_escape(val)}"')
        if t in _VOID:
            self._out.append("<" + " ".join(bits) + ">")
        else:
            self._out.append("<" + " ".join(bits) + ">")

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t in {"script", "style", "iframe", "object", "embed", "link", "meta", "form", "input", "button", "svg"}:
            if self._skip:
                self._skip -= 1
            return
        if self._skip or t not in _ALLOWED or t in _VOID:
            return
        if t == "span":
            extra = self._span_extra.pop() if self._span_extra else []
            for e in reversed(extra):
                self._out.append(f"</{e}>")
            self._out.append("</span>")
            return
        self._out.append(f"</{t}>")

    def handle_comment(self, data: str) -> None:
        if self._skip:
            return
        text = (data or "").strip()
        if text:
            self._out.append(_escape(text))

    def handle_data(self, data: str) -> None:
        if self._skip:
            return
        self._out.append(_escape(data))

    def handle_entityref(self, name: str) -> None:
        if not self._skip:
            self._out.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if not self._skip:
            self._out.append(f"&#{name};")


def sanitize_html(raw: str | None, *, max_len: int = 500_000) -> str:
    src = (raw or "")[:max_len]
    parser = _Sanitizer()
    try:
        parser.feed(src)
        parser.close()
    except Exception:
        return _escape(src)
    return "".join(parser._out)
