from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


def _create_engine(url: str):
    kwargs: dict = {"echo": False}
    if url.strip().lower().startswith("postgresql"):
        kwargs.update(pool_size=5, max_overflow=10, pool_pre_ping=True)
    return create_async_engine(url, **kwargs)


engine = _create_engine(settings.database_url)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

diagrams_engine = _create_engine(settings.diagrams_database_url)
DiagramsSessionLocal = async_sessionmaker(diagrams_engine, class_=AsyncSession, expire_on_commit=False)

warehouse_engine = _create_engine(settings.warehouse_database_url)
WarehouseSessionLocal = async_sessionmaker(warehouse_engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class DiagramsBase(DeclarativeBase):
    pass


class WarehouseBase(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session


async def get_diagrams_db() -> AsyncGenerator[AsyncSession, None]:
    async with DiagramsSessionLocal() as session:
        yield session


async def get_warehouse_db() -> AsyncGenerator[AsyncSession, None]:
    async with WarehouseSessionLocal() as session:
        yield session
