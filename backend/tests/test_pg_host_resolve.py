import socket

import pytest

from app.database import clear_pg_host_cache, resolve_pg_host


@pytest.fixture(autouse=True)
def _empty_cache():
    clear_pg_host_cache()
    yield
    clear_pg_host_cache()


@pytest.mark.asyncio
async def test_literal_ip_does_not_ask_dns():
    async def boom(host: str, port: int) -> str:
        raise AssertionError(f"lookup {host}:{port}")

    assert await resolve_pg_host("127.0.0.1", 5432, lookup=boom) == "127.0.0.1"


@pytest.mark.asyncio
async def test_name_is_resolved_once_and_then_cached():
    calls = 0

    async def once(host: str, port: int) -> str:
        nonlocal calls
        calls += 1
        assert host == "db"
        assert port == 5432
        return "10.1.2.3"

    assert await resolve_pg_host("db", 5432, lookup=once) == "10.1.2.3"
    assert await resolve_pg_host("db", 5432, lookup=once) == "10.1.2.3"
    assert calls == 1


@pytest.mark.asyncio
async def test_temporary_dns_failure_is_retried():
    calls = 0

    async def flaky(host: str, port: int) -> str:
        nonlocal calls
        calls += 1
        if calls < 3:
            err = OSError("Temporary failure in name resolution")
            err.errno = socket.EAI_AGAIN
            raise err
        return "10.1.2.4"

    assert await resolve_pg_host("db", 5432, lookup=flaky, delay=0) == "10.1.2.4"
    assert calls == 3
