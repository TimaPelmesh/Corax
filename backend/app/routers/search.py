from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_superuser, get_current_user
from app.database import get_db
from app.models import User
from app.schemas import SearchReindexResponse, SearchResponse, SearchResultOut
from app.search_index import SEARCH_ENTITY_TYPES, rebuild_search_index

router = APIRouter(prefix="/search", tags=["search"])


@router.get("", response_model=SearchResponse)
async def search_catalog(
    q: str = Query(..., min_length=2, max_length=200),
    types: list[str] = Query(default=[]),
    limit: int = Query(20, ge=1, le=100),
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return facts from the catalog; no LLM, embeddings, or prompt construction."""
    query = " ".join(q.split())
    selected_types = list(dict.fromkeys(t.strip() for t in types if t.strip()))
    invalid = sorted(set(selected_types) - SEARCH_ENTITY_TYPES)
    if invalid:
        raise HTTPException(status_code=400, detail=f"Unsupported search types: {', '.join(invalid)}")

    type_filter = ""
    params: dict[str, object] = {
        "q": query,
        "contains": f"%{query}%",
        "prefix": f"{query}%",
        "limit": limit,
    }
    statement = """
        WITH search_query AS (
            SELECT websearch_to_tsquery('russian', :q) AS tsq
        )
        SELECT
            d.entity_type,
            d.entity_id,
            d.title,
            COALESCE(
                NULLIF(ts_headline('russian', d.body, search_query.tsq,
                    'MaxWords=30, MinWords=10, StartSel=<b>, StopSel=</b>'), ''),
                NULLIF(left(d.body, 320), ''),
                d.title
            ) AS snippet,
            d.metadata_json,
            CASE
                WHEN lower(d.identifiers) = lower(:q) OR lower(d.title) = lower(:q) THEN 'exact'
                WHEN d.identifiers ILIKE :prefix OR d.title ILIKE :prefix THEN 'prefix'
                WHEN d.identifiers ILIKE :contains OR d.title ILIKE :contains THEN 'partial'
                WHEN d.search_vector @@ search_query.tsq THEN 'full_text'
                ELSE 'fuzzy'
            END AS match_kind,
            (
                CASE
                    WHEN lower(d.identifiers) = lower(:q) OR lower(d.title) = lower(:q) THEN 100.0
                    WHEN d.identifiers ILIKE :prefix OR d.title ILIKE :prefix THEN 50.0
                    WHEN d.identifiers ILIKE :contains OR d.title ILIKE :contains THEN 20.0
                    ELSE 0.0
                END
                + ts_rank_cd(d.search_vector, search_query.tsq) * 10.0
                + similarity(d.identifiers, :q)
            ) AS score
        FROM search_documents d
        CROSS JOIN search_query
        WHERE (
            d.identifiers ILIKE :contains
            OR d.title ILIKE :contains
            OR d.identifiers % :q
            OR d.title % :q
            OR d.search_vector @@ search_query.tsq
        )
    """
    if selected_types:
        type_filter = " AND d.entity_type IN :types"
        params["types"] = selected_types
    statement += type_filter + " ORDER BY score DESC, d.updated_at DESC, d.entity_id DESC LIMIT :limit"
    sql = text(statement)
    if selected_types:
        sql = sql.bindparams(bindparam("types", expanding=True))
    rows = (await db.execute(sql, params)).mappings().all()
    return SearchResponse(
        query=query,
        items=[
            SearchResultOut(
                entity_type=str(row["entity_type"]),
                entity_id=int(row["entity_id"]),
                title=str(row["title"]),
                snippet=str(row["snippet"]) if row["snippet"] else None,
                score=round(float(row["score"]), 5),
                match_kind=str(row["match_kind"]),
                metadata=dict(row["metadata_json"] or {}),
            )
            for row in rows
        ],
    )


@router.post("/reindex", response_model=SearchReindexResponse)
async def reindex_catalog(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Administrative recovery operation after restoring a database or bulk import."""
    indexed = await rebuild_search_index(db)
    await db.commit()
    return SearchReindexResponse(indexed=indexed)
