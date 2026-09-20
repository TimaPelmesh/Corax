"""Export / import of WikiRAG documents + chunk embeddings as a portable ZIP pack."""

from __future__ import annotations

import io
import json
import secrets
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.models import User, WikiRagChunk, WikiRagDocument
from app.observability import get_logger
from app.wikirag_index import INDEX_PENDING, INDEX_READY, _decode_embedding, _store_russian_search_vector
from app.wikirag_options import get_embed_model
from app.wikirag_pgvector import embed_dims, store_embedding_vec

log = get_logger(__name__)

PACK_VERSION = 1
MANIFEST_NAME = "manifest.json"
DOCUMENTS_NAME = "documents.jsonl"
CHUNKS_NAME = "chunks.jsonl"
FILES_PREFIX = "files/"


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _parse_dt(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _safe_pack_rel(raw: str) -> str:
    cleaned = (raw or "").replace("\\", "/").strip().lstrip("/")
    parts: list[str] = []
    for piece in cleaned.split("/"):
        piece = piece.strip()
        if not piece or piece in (".", ".."):
            continue
        parts.append(piece[:180])
    joined = "/".join(parts)
    if not joined or len(joined) > 480:
        raise HTTPException(status_code=400, detail="Некорректный путь в пакете.")
    return joined


async def build_index_zip(db: AsyncSession, storage_dir: Path) -> bytes:
    docs_r = await db.execute(
        select(WikiRagDocument).options(selectinload(WikiRagDocument.uploaded_by)).order_by(WikiRagDocument.id)
    )
    docs = list(docs_r.scalars().all())
    doc_ids = [int(d.id) for d in docs]
    chunks: list[WikiRagChunk] = []
    if doc_ids:
        ch_r = await db.execute(
            select(WikiRagChunk).where(WikiRagChunk.document_id.in_(doc_ids)).order_by(WikiRagChunk.document_id, WikiRagChunk.chunk_index)
        )
        chunks = list(ch_r.scalars().all())

    embed_model = (get_embed_model() or "").strip() or None
    manifest = {
        "version": PACK_VERSION,
        "format": "corax-wikirag-index",
        "exported_at": _iso(datetime.now(timezone.utc)),
        "embed_model": embed_model,
        "embed_dims": embed_dims(),
        "document_count": len(docs),
        "chunk_count": len(chunks),
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
        doc_lines: list[str] = []
        for d in docs:
            uploader = d.uploaded_by
            doc_lines.append(
                json.dumps(
                    {
                        "id": int(d.id),
                        "original_filename": d.original_filename,
                        "stored_filename": d.stored_filename,
                        "mime_type": d.mime_type,
                        "size_bytes": int(d.size_bytes or 0),
                        "comment": d.comment,
                        "uploaded_by_username": uploader.username if uploader else None,
                        "created_at": _iso(d.created_at),
                        "updated_at": _iso(d.updated_at),
                        "indexed_at": _iso(getattr(d, "indexed_at", None)),
                        "index_status": getattr(d, "index_status", None) or INDEX_PENDING,
                        "index_error": getattr(d, "index_error", None),
                        "chunk_count": int(getattr(d, "chunk_count", None) or 0),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            src = storage_dir / str(d.stored_filename).replace("\\", "/")
            if src.is_file():
                arc = FILES_PREFIX + str(d.stored_filename).replace("\\", "/")
                zf.write(src, arcname=arc)
        zf.writestr(DOCUMENTS_NAME, "\n".join(doc_lines) + ("\n" if doc_lines else ""))

        chunk_lines: list[str] = []
        for c in chunks:
            chunk_lines.append(
                json.dumps(
                    {
                        "document_id": int(c.document_id),
                        "chunk_index": int(c.chunk_index or 0),
                        "content": c.content,
                        "embedding": c.embedding,
                        "embedding_model": c.embedding_model,
                        "char_start": int(c.char_start or 0),
                        "char_end": int(c.char_end or 0),
                        "source_kind": c.source_kind,
                        "source_table": c.source_table,
                        "hostname": c.hostname,
                        "computer_id": c.computer_id,
                        "snapshot_at": _iso(c.snapshot_at),
                        "meta_json": c.meta_json,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
        zf.writestr(CHUNKS_NAME, "\n".join(chunk_lines) + ("\n" if chunk_lines else ""))

    return buf.getvalue()


def _read_jsonl(raw: bytes) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


async def import_index_zip(
    db: AsyncSession,
    storage_dir: Path,
    upload: UploadFile,
    current: User,
) -> dict[str, Any]:
    raw = await upload.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой архив.")
    if len(raw) > 512 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Архив слишком большой (макс. 512 МБ).")

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as e:
        raise HTTPException(status_code=400, detail="Некорректный ZIP.") from e

    warnings: list[str] = []
    with zf:
        names = set(zf.namelist())
        if MANIFEST_NAME not in names or DOCUMENTS_NAME not in names:
            raise HTTPException(status_code=400, detail="В архиве нет manifest.json / documents.jsonl.")
        try:
            manifest = json.loads(zf.read(MANIFEST_NAME).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise HTTPException(status_code=400, detail="Повреждённый manifest.json.") from e
        if not isinstance(manifest, dict):
            raise HTTPException(status_code=400, detail="Некорректный manifest.json.")

        pack_dims = int(manifest.get("embed_dims") or 0) or None
        local_dims = embed_dims()
        if pack_dims and pack_dims != local_dims:
            warnings.append(
                f"Размерность эмбеддингов в пакете ({pack_dims}) отличается от сервера ({local_dims}). "
                "Векторы pgvector могут потребовать переиндексации."
            )
        pack_model = (manifest.get("embed_model") or "").strip()
        local_model = (get_embed_model() or "").strip()
        if pack_model and local_model and pack_model != local_model:
            warnings.append(f"Модель в пакете «{pack_model}», на сервере «{local_model}».")

        docs_data = _read_jsonl(zf.read(DOCUMENTS_NAME))
        chunks_data = _read_jsonl(zf.read(CHUNKS_NAME)) if CHUNKS_NAME in names else []

        # Map old pack document id → new id
        id_map: dict[int, int] = {}
        imported_docs = 0
        skipped = 0

        for item in docs_data:
            try:
                original = _safe_pack_rel(str(item.get("original_filename") or ""))
                stored_hint = _safe_pack_rel(str(item.get("stored_filename") or original))
            except HTTPException:
                skipped += 1
                continue

            pack_id = item.get("id")
            file_arc = FILES_PREFIX + str(item.get("stored_filename") or "").replace("\\", "/")
            file_bytes: bytes | None = None
            if file_arc in names:
                file_bytes = zf.read(file_arc)
            else:
                # try by stored_hint under files/
                alt = FILES_PREFIX + stored_hint
                if alt in names:
                    file_bytes = zf.read(alt)

            if not file_bytes:
                warnings.append(f"Нет файла в архиве: {original}")
                skipped += 1
                continue

            # Replace existing doc with same logical path
            existing = (
                await db.execute(select(WikiRagDocument).where(WikiRagDocument.original_filename == original[:512]))
            ).scalar_one_or_none()
            if existing is not None:
                old_path = storage_dir / str(existing.stored_filename).replace("\\", "/")
                await db.delete(existing)
                await db.flush()
                try:
                    old_path.unlink(missing_ok=True)
                except OSError:
                    pass

            leaf = Path(stored_hint).name or Path(original).name
            if len(leaf) < 8 or "_" not in leaf[:20]:
                leaf = f"{secrets.token_hex(8)}_{Path(original).name}"
            parent = Path(original).parent
            if str(parent) in (".", ""):
                stored_rel = leaf
            else:
                stored_rel = str(parent / leaf).replace("\\", "/")

            dest = storage_dir / stored_rel
            resolved_root = storage_dir.resolve()
            if not dest.resolve().is_relative_to(resolved_root):
                skipped += 1
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(file_bytes)

            status = str(item.get("index_status") or INDEX_PENDING).lower()
            if status not in (INDEX_PENDING, INDEX_READY, "error"):
                status = INDEX_PENDING

            row = WikiRagDocument(
                original_filename=original[:512],
                stored_filename=stored_rel[:512],
                mime_type=(str(item.get("mime_type") or "").strip()[:128] or None),
                size_bytes=len(file_bytes),
                comment=(str(item.get("comment") or "").strip()[:4000] or None),
                uploaded_by_id=current.id,
                indexed_at=_parse_dt(item.get("indexed_at")),
                index_status=status,
                index_error=(str(item.get("index_error") or "").strip() or None),
                chunk_count=0,
            )
            db.add(row)
            await db.flush()
            if pack_id is not None:
                try:
                    id_map[int(pack_id)] = int(row.id)
                except (TypeError, ValueError):
                    pass
            imported_docs += 1

        imported_chunks = 0
        # Group chunks by pack document id
        by_doc: dict[int, list[dict[str, Any]]] = {}
        for ch in chunks_data:
            try:
                old_id = int(ch.get("document_id"))
            except (TypeError, ValueError):
                continue
            by_doc.setdefault(old_id, []).append(ch)

        for old_id, pieces in by_doc.items():
            new_id = id_map.get(old_id)
            if new_id is None:
                continue
            doc_row = await db.get(WikiRagDocument, new_id)
            if doc_row is None:
                continue
            has_emb = False
            for ch in sorted(pieces, key=lambda x: int(x.get("chunk_index") or 0)):
                content = str(ch.get("content") or "")
                if not content.strip():
                    continue
                emb_raw = ch.get("embedding")
                if isinstance(emb_raw, list):
                    emb_raw = json.dumps(emb_raw, separators=(",", ":"))
                elif emb_raw is not None:
                    emb_raw = str(emb_raw)
                chunk = WikiRagChunk(
                    document_id=new_id,
                    chunk_index=int(ch.get("chunk_index") or 0),
                    content=content,
                    embedding=emb_raw,
                    embedding_model=(str(ch.get("embedding_model") or "").strip()[:128] or None),
                    char_start=int(ch.get("char_start") or 0),
                    char_end=int(ch.get("char_end") or 0),
                    source_kind=(str(ch.get("source_kind") or "").strip()[:32] or None),
                    source_table=(str(ch.get("source_table") or "").strip()[:64] or None),
                    hostname=(str(ch.get("hostname") or "").strip()[:255] or None),
                    computer_id=ch.get("computer_id") if isinstance(ch.get("computer_id"), int) else None,
                    snapshot_at=_parse_dt(ch.get("snapshot_at")),
                    meta_json=(str(ch.get("meta_json") or "") or None),
                )
                db.add(chunk)
                await db.flush()
                await _store_russian_search_vector(db, int(chunk.id), content)
                vec = _decode_embedding(emb_raw if isinstance(emb_raw, str) else None)
                if vec and len(vec) == local_dims:
                    if await store_embedding_vec(db, int(chunk.id), vec):
                        has_emb = True
                elif vec:
                    has_emb = True
                imported_chunks += 1

            cnt = (
                await db.execute(select(WikiRagChunk.id).where(WikiRagChunk.document_id == new_id))
            ).scalars().all()
            doc_row.chunk_count = len(cnt)
            if doc_row.chunk_count > 0:
                doc_row.index_status = INDEX_READY
                if not doc_row.indexed_at:
                    doc_row.indexed_at = datetime.now(timezone.utc)
                if not has_emb:
                    doc_row.index_error = (doc_row.index_error or "") or "embed:import-partial"
            else:
                doc_row.index_status = INDEX_PENDING

        await db.commit()

    detail = f"Импортировано документов: {imported_docs}, чанков: {imported_chunks}"
    if skipped:
        detail += f", пропущено: {skipped}"
    log.info(
        "wikirag_index_import_done",
        extra={"documents": imported_docs, "chunks": imported_chunks, "skipped": skipped},
    )
    return {
        "ok": True,
        "documents": imported_docs,
        "chunks": imported_chunks,
        "skipped": skipped,
        "warnings": warnings,
        "detail": detail,
    }
