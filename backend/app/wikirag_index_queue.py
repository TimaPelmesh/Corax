"""Serial WikiRAG index queue — do not index inside the user request or flood BackgroundTasks."""

from __future__ import annotations

import asyncio

from app.observability import get_logger

log = get_logger("corax.wikirag_index_queue")


class WikiRagIndexQueue:
    def __init__(self) -> None:
        self._q: asyncio.Queue[int] | None = None
        self._pending: set[int] = set()
        self._deferred: list[int] = []
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.active_id: int | None = None

    @property
    def queue_size(self) -> int:
        return len(self._pending)

    @property
    def indexing(self) -> bool:
        return self.active_id is not None or bool(self._pending)

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._q = asyncio.Queue()
        for doc_id in self._deferred:
            if doc_id not in self._pending:
                self._pending.add(doc_id)
                self._q.put_nowait(doc_id)
        self._deferred.clear()
        self._task = asyncio.create_task(self._worker(), name="wikirag-index-queue")
        log.info("wikirag_index_queue_started")

    async def stop(self) -> None:
        self._stop.set()
        if self._q is not None:
            try:
                self._q.put_nowait(-1)
            except Exception:
                pass
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        self._q = None
        self.active_id = None

    def enqueue(self, *ids: int) -> int:
        """Queue document ids (deduped). Safe to call from request handlers."""
        added = 0
        q = self._q
        for raw in ids:
            try:
                doc_id = int(raw)
            except (TypeError, ValueError):
                continue
            if doc_id <= 0 or doc_id in self._pending:
                continue
            self._pending.add(doc_id)
            if q is None:
                self._deferred.append(doc_id)
            else:
                q.put_nowait(doc_id)
            added += 1
        if added:
            log.info("wikirag_index_enqueued", extra={"added": added, "queue_size": len(self._pending)})
        return added

    async def _worker(self) -> None:
        from app.wikirag_index import index_document_task

        q = self._q
        if q is None:
            return
        while not self._stop.is_set():
            try:
                doc_id = await q.get()
            except asyncio.CancelledError:
                break
            if doc_id <= 0:
                continue
            self.active_id = doc_id
            try:
                await index_document_task(doc_id)
            except Exception as e:
                log.warning("wikirag_index_queue_item_failed", extra={"document_id": doc_id, "error": str(e)[:400]})
            finally:
                self._pending.discard(doc_id)
                self.active_id = None
                q.task_done()


wikirag_index_queue = WikiRagIndexQueue()
