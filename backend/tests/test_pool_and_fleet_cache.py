"""Panel pool budget and the shared fleet read cache."""

from app.database import bitrix_engine, engine, interactive_pool_limits
from app.jwtutil import access_token_payload, encode_token
from app.panel_read_cache import _key


def _scope(path: str, token: str | None = None) -> dict:
    headers = []
    if token is not None:
        headers.append((b"cookie", f"access_token={token}".encode()))
    return {
        "type": "http",
        "method": "GET",
        "path": path,
        "query_string": b"limit=100",
        "headers": headers,
    }


def test_panel_pool_covers_fifty_users(monkeypatch):
    monkeypatch.setattr("app.database.settings.environment", "production")
    monkeypatch.delenv("CORAX_DB_POOL_SIZE", raising=False)
    monkeypatch.delenv("CORAX_DB_MAX_OVERFLOW", raising=False)
    size, overflow = interactive_pool_limits()
    assert size + overflow >= 50
    assert size >= 20


def test_bitrix_pool_is_not_the_panel_pool():
    assert bitrix_engine is not engine


def test_fleet_reads_share_one_cache_entry():
    alice = encode_token(access_token_payload("alice", 1))
    bob = encode_token(access_token_payload("bob", 4))
    assert _key(_scope("/api/v1/computers", alice)) == _key(_scope("/api/v1/computers", bob))
    assert _key(_scope("/api/v1/computers", alice)).startswith(b"s|")


def test_notes_and_tickets_stay_per_session():
    alice = encode_token(access_token_payload("alice", 1))
    bob = encode_token(access_token_payload("bob", 4))
    assert _key(_scope("/api/v1/notes", alice)) != _key(_scope("/api/v1/notes", bob))
    assert _key(_scope("/api/v1/service-requests", alice)) != _key(_scope("/api/v1/service-requests", bob))


def test_garbage_cookie_does_not_read_the_fleet_cache():
    alice = encode_token(access_token_payload("alice", 1))
    shared = _key(_scope("/api/v1/printers", alice))
    junk = _key(_scope("/api/v1/printers", "not-a-jwt"))
    assert junk != shared
    assert not junk.startswith(b"s|")


def test_anonymous_fleet_read_is_not_shared():
    assert not _key(_scope("/api/v1/computers")).startswith(b"s|")
