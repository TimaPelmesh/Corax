from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


def _normalize_url(url: str) -> str:
    return (url or "").strip()


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
        # pre_ping отбраковывает соединение, которое Postgres уже закрыл.
        # LIFO берёт недавно живое соединение, а не то, что простояло полчаса.
        # statement_timeout обрывает запрос, idle_in_transaction — сессию,
        # которую забыли закрыть. Фоновые движки передают свои лимиты.
        kwargs.update(
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_pre_ping=True,
            pool_use_lifo=True,
            pool_recycle=1800,
            pool_timeout=8,
            connect_args={
                "command_timeout": max(8, int(statement_timeout_ms / 1000) + 5),
                "server_settings": {
                    "statement_timeout": str(int(statement_timeout_ms)),
                    "idle_in_transaction_session_timeout": str(int(idle_in_transaction_ms)),
                },
            },
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


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


async def get_diagrams_db() -> AsyncGenerator[AsyncSession, None]:
    async with DiagramsSessionLocal() as session:
        yield session


async def get_warehouse_db() -> AsyncGenerator[AsyncSession, None]:
    async with WarehouseSessionLocal() as session:
        yield session
