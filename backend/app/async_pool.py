from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")
_SENTINEL = object()


async def run_async_pool(
    items: list[T],
    worker: Callable[[T], Awaitable[None]],
    concurrency: int,
) -> None:
    """Run async worker over items with at most `concurrency` tasks (not len(items) tasks)."""
    if not items:
        return
    n = max(1, min(concurrency, len(items)))
    q: asyncio.Queue = asyncio.Queue()
    for item in items:
        q.put_nowait(item)

    async def runner() -> None:
        while True:
            item = await q.get()
            if item is _SENTINEL:
                q.task_done()
                return
            try:
                await worker(item)
            finally:
                q.task_done()

    tasks = [asyncio.create_task(runner()) for _ in range(n)]
    for _ in range(n):
        q.put_nowait(_SENTINEL)
    await q.join()
    await asyncio.gather(*tasks, return_exceptions=True)
