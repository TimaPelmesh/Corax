import asyncio
import ipaddress
import socket
from collections.abc import AsyncGenerator, Awaitable, Callable

from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

# One lookup serves every new asyncpg connection. Docker's DNS (127.0.0.11)
# answers "Temporary failure in name resolution" when many connects resolve
# the service name `db` at the same instant.
_HOST_TTL_SEC = 60.0
_host_cache: dict[str, tuple[float, str]] = {}
_host_lock: asyncio.Lock | None = None

Lookup = Callable[[str, int], Awaitable[str]]


def _normalize_url(url: str) -> str:
    return (url or "").strip()


def _host_lock_for_loop() -> asyncio.Lock:
    global _host_lock
    if _host_lock is None:
        _host_lock = asyncio.Lock()
    return _host_lock


def clear_pg_host_cache() -> None:
    _host_cache.clear()


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


async def _lookup_ipv4(host: str, port: int) -> str:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
    if not infos:
        raise OSError(f"no IPv4 address for {host}")
    return str(infos[0][4][0])


async def resolve_pg_host(
    host: str,
    port: int,
    *,
    lookup: Lookup | None = None,
    attempts: int = 5,
    delay: float = 0.2,
) -> str:
    """Resolve a Postgres host once, then reuse the address for a minute.

    Retries Temporary failure in name resolution (EAI_AGAIN). A literal IP
    is returned as-is. Callers share one lock so a burst of new pool
    connections makes a single DNS query.
    """
    host = (host or "").strip()
    if not host or _is_ip(host):
        return host
    now = asyncio.get_running_loop().time()
    cached = _host_cache.get(host)
    if cached is not None and cached[0] > now:
        return cached[1]
    find = lookup or _lookup_ipv4
    async with _host_lock_for_loop():
        now = asyncio.get_running_loop().time()
        cached = _host_cache.get(host)
        if cached is not None and cached[0] > now:
            return cached[1]
        last: OSError | None = None
        for attempt in range(max(1, attempts)):
            try:
                ip = await find(host, port)
            except OSError as exc:
                last = exc
                if attempt + 1 == attempts:
                    break
                await asyncio.sleep(delay * (attempt + 1))
                continue
            _host_cache[host] = (now + _HOST_TTL_SEC, ip)
            return ip
        assert last is not None
        raise last


def _timeout_ms(value: int | None, env_name: str, default: int) -> int:
    if value is not None:
        return int(value)
    import os

    raw = (os.environ.get(env_name) or "").strip()
    if raw.isdigit():
        return int(raw)
    return default


def _create_engine(
    url: str,
    *,
    pool_size: int = 10,
    max_overflow: int = 10,
    statement_timeout_ms: int | None = None,
    idle_in_transaction_ms: int | None = None,
):
    statement_timeout_ms = _timeout_ms(statement_timeout_ms, "CORAX_DB_STATEMENT_TIMEOUT_MS", 20_000)
    idle_in_transaction_ms = _timeout_ms(idle_in_transaction_ms, "CORAX_DB_IDLE_TX_TIMEOUT_MS", 20_000)
    kwargs: dict = {"echo": False}
    if url.strip().lower().startswith("postgresql"):
        # Панель и агенты делят этот пул. Фоновые потоки (ping, SNMP)
        # зовут _create_engine со своим маленьким пулом и сюда не лезут.
        # Пул намеренно небольшой. Имя базы резолвится один раз (resolve_pg_host),
        # а не на каждый новый коннект: рост пула только множит сессии Postgres.
        # pre_ping отбраковывает соединение, которое Postgres уже закрыл.
        # LIFO берёт недавно живое соединение, а не то, что простояло полчаса.
        # statement_timeout обрывает запрос, idle_in_transaction — сессию,
        # которую забыли закрыть. Фоновые движки передают свои лимиты.
        parsed = make_url(url)
        command_timeout = max(8, int(statement_timeout_ms / 1000) + 5)
        server_settings = {
            "statement_timeout": str(int(statement_timeout_ms)),
            "idle_in_transaction_session_timeout": str(int(idle_in_transaction_ms)),
        }

        async def _connect():
            import asyncpg

            host = parsed.host or "localhost"
            port = int(parsed.port or 5432)
            try:
                address = await resolve_pg_host(host, port)
            except OSError:
                clear_pg_host_cache()
                raise
            try:
                return await asyncpg.connect(
                    host=address,
                    port=port,
                    user=parsed.username,
                    password=parsed.password,
                    database=parsed.database,
                    timeout=5,
                    command_timeout=command_timeout,
                    server_settings=server_settings,
                )
            except OSError:
                clear_pg_host_cache()
                raise

        kwargs.update(
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_pre_ping=True,
            pool_use_lifo=True,
            pool_recycle=1800,
            pool_timeout=8,
            async_creator=_connect,
        )
    return create_async_engine(url, **kwargs)


# Три URL из .env часто указывают на одну и ту же PostgreSQL (Docker по
# умолчанию так и делает). До этой правки заводились три независимых пула
# (3 × 5 idle-коннектов минимум), что нагружало Postgres пустыми SESSION
# и удлиняло старт. Схлопываем в один engine при совпадающих DSN, сохраняя
# публичные символы engine / diagrams_engine / warehouse_engine и
# соответствующие session-фабрики — все Depends(get_db/…​) продолжают работать.
_engines_by_url: dict[str, object] = {}


def _shared_engine(url: str):
    key = _normalize_url(url)
    eng = _engines_by_url.get(key)
    if eng is None:
        eng = _create_engine(url)
        _engines_by_url[key] = eng
    return eng


engine = _shared_engine(settings.database_url)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

diagrams_engine = _shared_engine(settings.diagrams_database_url)
DiagramsSessionLocal = async_sessionmaker(diagrams_engine, class_=AsyncSession, expire_on_commit=False)

warehouse_engine = _shared_engine(settings.warehouse_database_url)
WarehouseSessionLocal = async_sessionmaker(warehouse_engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class DiagramsBase(DeclarativeBase):
    pass


class WarehouseBase(DeclarativeBase):
    pass


async def release_connection(session: AsyncSession) -> None:
    """Commit pending work and return the connection before a long network wait.

    Closing the session puts the connection back in the pool. The same session
    object checks out a new connection on the next query.
    """
    try:
        if session.in_transaction():
            await session.commit()
    except Exception:
        try:
            await session.rollback()
        except Exception:
            pass
    await session.close()


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except BaseException:
            try:
                await session.rollback()
            except BaseException:
                pass
            raise


async def get_diagrams_db() -> AsyncGenerator[AsyncSession, None]:
    async with DiagramsSessionLocal() as session:
        yield session


async def get_warehouse_db() -> AsyncGenerator[AsyncSession, None]:
    async with WarehouseSessionLocal() as session:
        yield session
