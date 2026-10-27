from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.observability import get_logger

log = get_logger(__name__)

_pgvector_ready: bool | None = None
_pgvector_dims: int | None = None


def embed_dims() -> int:
    return max(64, min(4096, int(getattr(settings, "wiki_rag_embed_dims", None) or 1024)))


def vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{float(x):.8g}" for x in vec) + "]"


async def ensure_pgvector(db: AsyncSession) -> bool:
    """Ensure extension + embedding_vec column match configured dims (bge-m3=1024)."""
    global _pgvector_ready, _pgvector_dims
    dims = embed_dims()
    if _pgvector_ready is True and _pgvector_dims == dims:
        return True
    try:
        bind = db.get_bind()
        if bind.dialect.name != "postgresql":
            _pgvector_ready = False
            _pgvector_dims = None
            return False
        await db.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        # Detect current vector size if column exists.
        row = (
            await db.execute(
                text(
                    """
                    SELECT format_type(a.atttypid, a.atttypmod) AS typ
                    FROM pg_attribute a
                    JOIN pg_class c ON c.oid = a.attrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = 'wiki_rag_chunks'
                      AND a.attname = 'embedding_vec'
                      AND NOT a.attisdropped
                      AND n.nspname = 'public'
                    """
                )
            )
        ).first()
        need_recreate = True
        if row and row[0]:
            typ = str(row[0])
            # e.g. vector(768) or vector
            if f"vector({dims})" in typ:
                need_recreate = False
            elif typ.startswith("vector"):
                need_recreate = True
        if need_recreate:
            await db.execute(text("DROP INDEX IF EXISTS ix_wiki_rag_chunks_embedding_vec_hnsw"))
            await db.execute(text("DROP INDEX IF EXISTS ix_wiki_rag_chunks_embedding_vec_ivfflat"))
            await db.execute(text("ALTER TABLE wiki_rag_chunks DROP COLUMN IF EXISTS embedding_vec"))
            await db.execute(
                text(f"ALTER TABLE wiki_rag_chunks ADD COLUMN embedding_vec vector({int(dims)})")
            )
            try:
                await db.execute(
                    text(
                        "CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_embedding_vec_hnsw "
                        "ON wiki_rag_chunks USING hnsw (embedding_vec vector_cosine_ops)"
                    )
                )
            except Exception:
                try:
                    await db.execute(
                        text(
                            "CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_embedding_vec_ivfflat "
                            "ON wiki_rag_chunks USING ivfflat (embedding_vec vector_cosine_ops) "
                            "WITH (lists = 100)"
                        )
                    )
                except Exception:
                    pass
            log.info("wikirag_pgvector_column_resized", extra={"dims": dims})
        await db.commit()
        _pgvector_ready = True
        _pgvector_dims = dims
        return True
    except Exception as e:
        log.info("wikirag_pgvector_unavailable", extra={"error": str(e)[:240]})
        try:
            await db.rollback()
        except Exception:
            pass
        _pgvector_ready = False
        _pgvector_dims = None
        return False


def reset_pgvector_cache() -> None:
    global _pgvector_ready, _pgvector_dims
    _pgvector_ready = None
    _pgvector_dims = None


async def store_embedding_vec(db: AsyncSession, chunk_id: int, vec: list[float] | None) -> bool:
    if not vec or len(vec) != embed_dims():
        return False
    if not await ensure_pgvector(db):
        return False
    lit = vector_literal(vec)
    try:
        await db.execute(
            text(
                "UPDATE wiki_rag_chunks "
                "SET embedding_vec = CAST(:v AS vector) "
                "WHERE id = :id"
            ),
            {"v": lit, "id": int(chunk_id)},
        )
        return True
    except Exception as e:
        log.warning("wikirag_store_vec_failed", extra={"chunk_id": chunk_id, "error": str(e)[:240]})
        return False


async def store_embedding_vecs_bulk(
    db: AsyncSession,
    pairs: list[tuple[int, list[float]]],
) -> int:
    """Write many pgvector embeddings with one ensure_pgvector + batched UPDATEs."""
    if not pairs:
        return 0
    dims = embed_dims()
    clean = [(int(cid), vec) for cid, vec in pairs if vec and len(vec) == dims]
    if not clean:
        return 0
    if not await ensure_pgvector(db):
        return 0
    ok = 0
    # Chunk SQL payloads — each 1024-d literal is ~10KB; keep statements manageable.
    step = 64
    try:
        for i in range(0, len(clean), step):
            part = clean[i : i + step]
            values_sql = ", ".join(
                f"({cid}::int, CAST('{vector_literal(vec)}' AS vector))" for cid, vec in part
            )
            await db.execute(
                text(
                    f"""
                    UPDATE wiki_rag_chunks AS c
                    SET embedding_vec = v.emb
                    FROM (VALUES {values_sql}) AS v(id, emb)
                    WHERE c.id = v.id
                    """
                )
            )
            ok += len(part)
        return ok
    except Exception as e:
        log.warning("wikirag_store_vec_bulk_failed", extra={"error": str(e)[:240], "n": len(clean)})
        # Fallback: per-row (still after a single ensure_pgvector).
        ok = 0
        for cid, vec in clean:
            if await store_embedding_vec(db, cid, vec):
                ok += 1
        return ok


async def search_by_vector(
    db: AsyncSession,
    query_vec: list[float],
    document_ids: list[int],
    *,
    top_k: int = 10,
):
    from sqlalchemy import bindparam

    if not document_ids or not query_vec or len(query_vec) != embed_dims():
        return None
    if not await ensure_pgvector(db):
        return None
    lit = vector_literal(query_vec)
    ids = [int(i) for i in document_ids]
    try:
        stmt = text(
            """
            SELECT c.id, c.document_id, c.chunk_index, c.content,
                   c.source_kind, c.source_table, c.hostname, c.computer_id,
                   c.snapshot_at, c.meta_json,
                   d.original_filename AS filename,
                   (1 - (c.embedding_vec <=> CAST(:q AS vector))) AS score
            FROM wiki_rag_chunks c
            JOIN wiki_rag_documents d ON d.id = c.document_id
            WHERE c.document_id IN :ids
              AND c.embedding_vec IS NOT NULL
            ORDER BY c.embedding_vec <=> CAST(:q AS vector)
            LIMIT :k
            """
        ).bindparams(bindparam("ids", expanding=True))
        r = await db.execute(stmt, {"q": lit, "ids": ids, "k": int(top_k)})
        rows = r.mappings().all()
        return [dict(row) for row in rows]
    except Exception as e:
        log.info("wikirag_pgvector_search_failed", extra={"error": str(e)[:300]})
        return None
