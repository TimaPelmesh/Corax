"""Periodic CORAX → WikiRAG export + reindex so the vector index stays fresh."""

from __future__ import annotations

import asyncio
import secrets
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.models import User, WikiRagDocument
from app.observability import get_logger
from app.wikirag_corax import (
    CORAX_BUNDLE_FILENAMES,
    CORAX_FOLDER,
    CORAX_LEGACY_FILENAMES,
    CORAX_README_FILENAME,
    build_corax_knowledge_bundle,
    corax_file_comment,
)
from app.wikirag_index import INDEX_PENDING

log = get_logger(__name__)


def _storage_dir() -> Path:
    base = (settings.wiki_rag_dir or "wiki_rag_docs").strip() or "wiki_rag_docs"
    root = Path(base)
    if not root.is_absolute():
        root = Path(__file__).resolve().parent.parent / root
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_stem(name: str) -> str:
    stem = Path(name).stem
    out = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in stem)
    return (out or "doc")[:80]


async def sync_corax_wiki_docs(*, uploaded_by_id: int | None = None) -> dict[str, int]:
    """Export live CORAX snapshot into WikiRAG files and queue reindex."""
    async with AsyncSessionLocal() as db:
        if uploaded_by_id is None:
            uid = await db.scalar(
                select(User.id).where(User.is_superuser.is_(True)).order_by(User.id.asc()).limit(1)
            )
            if uid is None:
                uid = await db.scalar(select(User.id).order_by(User.id.asc()).limit(1))
            uploaded_by_id = int(uid) if uid is not None else None
        if uploaded_by_id is None:
            log.warning("wikirag_corax_sync_no_user")
            return {"files": 0, "created": 0}

        bundle, stats = await build_corax_knowledge_bundle(db)
        created = 0
        doc_ids: list[int] = []

        folder_dir = _storage_dir() / CORAX_FOLDER
        folder_dir.mkdir(parents=True, exist_ok=True)
        keep = folder_dir / ".corax_folder"
        if not keep.exists():
            keep.write_text("", encoding="utf-8")

        for filename in CORAX_BUNDLE_FILENAMES:
            if filename not in bundle:
                continue
            content = bundle[filename]
            raw = content.encode("utf-8")
            mime = "text/csv" if filename.lower().endswith(".csv") else "text/markdown"
            r = await db.execute(select(WikiRagDocument).where(WikiRagDocument.original_filename == filename))
            row = r.scalar_one_or_none()
            if row is None:
                stored = f"{secrets.token_hex(8)}_{_safe_stem(filename)}{Path(filename).suffix or '.txt'}"
                dest = _storage_dir() / stored
                dest.write_bytes(raw)
                row = WikiRagDocument(
                    original_filename=filename,
                    stored_filename=stored,
                    mime_type=mime,
                    size_bytes=len(raw),
                    comment=corax_file_comment(filename),
                    uploaded_by_id=uploaded_by_id,
                    index_status=INDEX_PENDING,
                )
                db.add(row)
                created += 1
            else:
                dest = _storage_dir() / row.stored_filename
                dest.write_bytes(raw)
                row.size_bytes = len(raw)
                row.comment = corax_file_comment(filename)
                row.mime_type = mime
                row.index_status = INDEX_PENDING
                row.index_error = None
            await db.flush()
            doc_ids.append(int(row.id))

        legacy_r = await db.execute(
            select(WikiRagDocument).where(WikiRagDocument.original_filename.in_(CORAX_LEGACY_FILENAMES))
        )
        for legacy in legacy_r.scalars().all():
            try:
                (_storage_dir() / legacy.stored_filename).unlink(missing_ok=True)
            except OSError:
                pass
            await db.delete(legacy)

        await db.commit()

    log.info(
        "wikirag_corax_sync_done",
        extra={
            "files": len(doc_ids),
            "created": created,
            "computers": int(stats.get("computers") or 0),
            "at": datetime.now(timezone.utc).isoformat(),
            "readme": CORAX_README_FILENAME,
        },
    )
    return {"files": len(doc_ids), "created": created, "computers": int(stats.get("computers") or 0)}


class WikiRagCoraxSyncScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        mins = int(getattr(settings, "wiki_rag_corax_sync_minutes", None) or 0)
        if mins <= 0:
            log.info("wikirag_corax_sync_disabled")
            return
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(mins), name="wikirag-corax-sync")
        log.info("wikirag_corax_sync_started", extra={"minutes": mins})

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _loop(self, minutes: int) -> None:
        # First run shortly after boot so Docker has LM Studio time to wake.
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=45)
            return
        except asyncio.TimeoutError:
            pass
        while not self._stop.is_set():
            try:
                await sync_corax_wiki_docs()
            except Exception as e:
                log.warning("wikirag_corax_sync_failed", extra={"error": str(e)[:400]})
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=max(60, minutes * 60))
                return
            except asyncio.TimeoutError:
                continue


wikirag_corax_sync_scheduler = WikiRagCoraxSyncScheduler()
