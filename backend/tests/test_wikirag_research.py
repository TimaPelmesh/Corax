"""Изоляция исследовательского режима: только публичные URL и текст страниц."""

from app.wikirag_research import (
    RESEARCH_SYSTEM,
    build_research_messages,
    host_is_public,
    parse_search_results,
    public_url_allowed,
    unwrap_search_href,
)


def test_private_and_local_urls_are_rejected():
    assert public_url_allowed("http://127.0.0.1/admin") is False
    assert public_url_allowed("http://10.1.1.5/wiki") is False
    assert public_url_allowed("http://192.168.0.20/") is False
    assert public_url_allowed("http://169.254.169.254/latest/meta-data") is False
    assert public_url_allowed("https://localhost/secret") is False
    assert public_url_allowed("file:///etc/passwd") is False
    assert public_url_allowed("https://user:pass@example.com/a") is False
    assert public_url_allowed("https://printer.local/setup") is False


def test_public_ip_literal_is_allowed_without_dns():
    assert host_is_public("8.8.8.8") is True
    assert host_is_public("10.0.0.8") is False


def test_search_parser_drops_private_targets(monkeypatch):
    monkeypatch.setattr("app.wikirag_research.host_is_public", lambda host: host == "docs.example.com")
    html = """
    <a class="result__a" href="https://docs.example.com/ollama">Ollama</a>
    <td class="result__snippet">set num_ctx</td>
    <a class="result__a" href="http://10.0.0.5/admin">secret</a>
    <td class="result__snippet">do not fetch</td>
    """
    hits = parse_search_results(html)
    assert len(hits) == 1
    assert hits[0]["url"] == "https://docs.example.com/ollama"
    assert "num_ctx" in hits[0]["snippet"]


def test_duckduckgo_redirect_is_unwrapped():
    href = "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide&rut=1"
    assert unwrap_search_href(href) == "https://docs.example.com/guide"


def test_research_prompt_contains_only_the_question_and_pages():
    messages = build_research_messages(
        "как выставить num_ctx в Ollama",
        [{"title": "Docs", "url": "https://docs.example.com/guide", "text": "PARAMETER num_ctx 8192"}],
        [],
    )
    blob = "\n".join(item["content"] for item in messages)
    assert messages[0]["content"] == RESEARCH_SYSTEM
    assert "num_ctx" in blob
    assert "https://docs.example.com/guide" in blob
    assert "PC-OLD" not in blob
    assert "agent_token" not in blob
    assert "192.168." not in blob
    assert "include_corax" not in blob
