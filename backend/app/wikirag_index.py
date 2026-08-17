"""WikiRAG chunking, Ollama/OpenAI embeddings, and hybrid retrieval."""

from __future__ import annotations

import csv
import io
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import bindparam, delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.models import WikiRagChunk, WikiRagDocument
from app.observability import get_logger
from app.wikirag_content import context_keywords, extract_plaintext
from app.wikirag_lm import normalize_lm_base_url
from app.wikirag_pgvector import embed_dims, search_by_vector, store_embedding_vecs_bulk

log = get_logger(__name__)

INDEX_PENDING = "pending"
INDEX_READY = "ready"
INDEX_ERROR = "error"

CSV_DELIM = ";"

CORAX_FILENAME_TO_TABLE: dict[str, str] = {
    "00_system_index.md": "readme",
    "CORAX_README.md": "readme",  # legacy flat
    "CORAX_компьютеры.md": "computers",
    "CORAX_железо.md": "hardware",
    "CORAX_ПО.md": "software",
    "CORAX_ПО_статистика.md": "software_stats",
    "CORAX_принтеры.md": "printers",
    "CORAX_сеть.md": "network",
    "CORAX_заявки.md": "tickets",
    "CORAX_пользователи.md": "users",
    "CORAX_теги.md": "tags",
    # legacy CSV names (если остались на диске до очистки)
    "CORAX_компьютеры.csv": "computers",
    "CORAX_теги_пк.csv": "tags",
    "CORAX_ПО.csv": "software",
    "CORAX_периферия.csv": "peripherals",
    "CORAX_диски.csv": "disks",
    "CORAX_принтеры.csv": "printers",
    "CORAX_заявки.csv": "tickets",
    "CORAX_пользователи.csv": "users",
}

_SNAPSHOT_RE = re.compile(r"снимок\s+(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})", re.IGNORECASE)
_CORAX_MD_HEADING_RE = re.compile(
    r"^##\s+(?P<title>.+?)(?:\s*\((?:computer_id|printer_id|user_id|request_id|network_id)=(?P<id>\d+)\))?\s*$",
    re.MULTILINE,
)


def embed_base_url() -> str:
    override = (settings.wiki_rag_embed_base_url or "").strip()
    return normalize_lm_base_url(override or None)


def embed_model() -> str:
    from app.wikirag_options import get_embed_model

    return get_embed_model()


def chunk_size() -> int:
    return max(200, int(getattr(settings, "wiki_rag_chunk_size", None) or 1500))


def chunk_overlap() -> int:
    size = chunk_size()
    ov = int(getattr(settings, "wiki_rag_chunk_overlap", None) or 300)
    return max(0, min(ov, size // 2))


def retrieve_top_k() -> int:
    return max(1, min(64, int(getattr(settings, "wiki_rag_retrieve_top_k", None) or 45)))


@dataclass
class TextChunk:
    text: str
    char_start: int
    char_end: int
    source_kind: str | None = None
    source_table: str | None = None
    hostname: str | None = None
    computer_id: int | None = None
    snapshot_at: datetime | None = None
    meta: dict[str, Any] | None = field(default=None, repr=False)


# LangChain RecursiveCharacterTextSplitter separators (script: 1500/300).
_REC_SEPARATORS = ("\n\n", "\n", ". ", " ", "")


def recursive_character_split(
    text: str,
    *,
    size: int | None = None,
    overlap: int | None = None,
    separators: tuple[str, ...] = _REC_SEPARATORS,
) -> list[str]:
    """Split text like langchain_text_splitters.RecursiveCharacterTextSplitter."""
    clean = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not clean:
        return []
    size = size or chunk_size()
    overlap = overlap if overlap is not None else chunk_overlap()
    overlap = max(0, min(overlap, size // 2))

    def _split(blob: str, seps: tuple[str, ...]) -> list[str]:
        if len(blob) <= size:
            return [blob] if blob else []
        if not seps:
            out: list[str] = []
            step = max(1, size - overlap)
            for i in range(0, len(blob), step):
                piece = blob[i : i + size]
                if piece.strip():
                    out.append(piece)
                if i + size >= len(blob):
                    break
            return out
        sep, *rest = seps
        parts = blob.split(sep) if sep else list(blob)
        chunks: list[str] = []
        buf = ""
        for part in parts:
            candidate = part if not buf else (buf + sep + part if sep else buf + part)
            if len(candidate) <= size:
                buf = candidate
                continue
            if buf.strip():
                chunks.append(buf)
            if len(part) > size:
                chunks.extend(_split(part, tuple(rest)))
                buf = ""
            else:
                buf = part
        if buf.strip():
            chunks.append(buf)
        # Apply overlap between adjacent chunks when joined by hard cuts.
        if overlap <= 0 or len(chunks) <= 1:
            return chunks
        overlapped: list[str] = [chunks[0]]
        for prev, cur in zip(chunks, chunks[1:]):
            prefix = prev[-overlap:] if len(prev) >= overlap else prev
            merged = (prefix + ("\n" if not prefix.endswith("\n") else "") + cur).strip()
            overlapped.append(merged if len(merged) <= size + overlap else cur)
        return overlapped

    return [c.strip() for c in _split(clean, separators) if c.strip()]


def chunk_text(text: str, *, size: int | None = None, overlap: int | None = None) -> list[TextChunk]:
    """Classic recursive split (script.py) with heading-aware fallback for markdown."""
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []
    size = size or chunk_size()
    overlap = overlap if overlap is not None else chunk_overlap()
    # Prefer recursive splitter — same behaviour as working Desktop/RAG pipeline.
    pieces = recursive_character_split(raw, size=size, overlap=overlap)
    chunks: list[TextChunk] = []
    cursor = 0
    for piece in pieces:
        pos = raw.find(piece[: min(40, len(piece))], cursor)
        if pos < 0:
            pos = cursor
        chunks.append(TextChunk(text=piece, char_start=pos, char_end=pos + len(piece)))
        cursor = pos + max(1, len(piece) - overlap)
    return chunks


def _parse_snapshot_from_readme(text: str) -> datetime | None:
    m = _SNAPSHOT_RE.search(text or "")
    if not m:
        return None
    try:
        dt = datetime.strptime(m.group(1).strip(), "%Y-%m-%d %H:%M")
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _snapshot_from_path(path: Path | None) -> datetime | None:
    if path is None or not path.is_file():
        return None
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    except OSError:
        return None


def _normalize_filename(name: str) -> str:
    return Path(name or "").name


def _extract_row_ids(header: list[str], cells: list[str]) -> tuple[str | None, int | None]:
    row = {header[i]: (cells[i] if i < len(cells) else "").strip() for i in range(len(header))}
    hostname = (row.get("hostname") or "").strip() or None
    computer_id: int | None = None
    cid_raw = (row.get("computer_id") or "").strip()
    if cid_raw.isdigit():
        computer_id = int(cid_raw)
    return hostname, computer_id


def _format_corax_row(source_table: str, header: list[str], cells: list[str], filename: str) -> str:
    pairs: list[str] = []
    for i, col in enumerate(header):
        val = (cells[i] if i < len(cells) else "").strip()
        if val:
            pairs.append(f"{col}={val}")
    body = "; ".join(pairs) if pairs else "(пустая строка)"
    return f"[CORAX:{source_table}] файл={filename}\n{body}"


def chunk_corax_csv(
    text: str,
    *,
    source_table: str,
    filename: str,
    snapshot_at: datetime | None = None,
    rows_per_chunk: int | None = None,
) -> list[TextChunk]:
    """Чанки CSV CORAX: пакет строк с метаданными hostname/computer_id."""
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not raw.strip():
        return []

    reader = csv.reader(io.StringIO(raw), delimiter=CSV_DELIM)
    rows = list(reader)
    if not rows:
        return []

    header = [(h or "").strip() for h in rows[0]]
    if not header or not any(header):
        return []

    # ПО/заявки — плотнее; компьютеры — по одной/несколько строк.
    if rows_per_chunk is None:
        rows_per_chunk = 8 if source_table in ("software", "tickets", "peripherals") else 12

    data_rows = [r for r in rows[1:] if any((c or "").strip() for c in r)]
    chunks: list[TextChunk] = []
    offset = 0
    for i in range(0, len(data_rows), rows_per_chunk):
        batch = data_rows[i : i + rows_per_chunk]
        parts: list[str] = []
        hostnames: list[str] = []
        computer_ids: list[int] = []
        for row in batch:
            cells = list(row)
            if len(cells) < len(header):
                cells.extend([""] * (len(header) - len(cells)))
            cells = cells[: len(header)]
            hostname, computer_id = _extract_row_ids(header, cells)
            if hostname:
                hostnames.append(hostname)
            if computer_id is not None:
                computer_ids.append(computer_id)
            parts.append(_format_corax_row(source_table, header, cells, filename))
        content = "\n---\n".join(parts)
        primary_host = hostnames[0] if len(set(hostnames)) == 1 else None
        primary_cid = computer_ids[0] if len(set(computer_ids)) == 1 else None
        chunks.append(
            TextChunk(
                text=content,
                char_start=offset,
                char_end=offset + len(content),
                source_kind="corax",
                source_table=source_table,
                hostname=primary_host,
                computer_id=primary_cid,
                snapshot_at=snapshot_at,
                meta={
                    "filename": filename,
                    "row_start": i + 1,
                    "row_end": i + len(batch),
                    "hostnames": sorted(set(hostnames))[:40],
                    "computer_ids": sorted(set(computer_ids))[:40],
                },
            )
        )
        offset += len(content) + 2
    return chunks


def chunk_corax_markdown(
    text: str,
    *,
    source_table: str,
    filename: str,
    snapshot_at: datetime | None = None,
) -> list[TextChunk]:
    """Чанки CORAX MD: одна секция ``## hostname (computer_id=N)`` ≈ один чанк."""
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []

    matches = list(_CORAX_MD_HEADING_RE.finditer(raw))
    if not matches:
        return [
            TextChunk(
                text=p.text,
                char_start=p.char_start,
                char_end=p.char_end,
                source_kind="corax",
                source_table=source_table,
                snapshot_at=snapshot_at,
                meta={"filename": filename},
            )
            for p in chunk_text(raw)
        ]

    chunks: list[TextChunk] = []
    if matches[0].start() > 0:
        prologue = raw[: matches[0].start()].strip()
        if prologue:
            chunks.append(
                TextChunk(
                    text=f"[CORAX:{source_table}] файл={filename}\n{prologue}",
                    char_start=0,
                    char_end=matches[0].start(),
                    source_kind="corax",
                    source_table=source_table,
                    snapshot_at=snapshot_at,
                    meta={"filename": filename, "section": "intro"},
                )
            )

    size_limit = max(chunk_size() * 2, 1800)
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
        section = raw[start:end].strip()
        if not section:
            continue
        title = (m.group("title") or "").strip()
        hostname: str | None = None
        computer_id: int | None = None
        id_raw = m.group("id")
        if id_raw and id_raw.isdigit():
            computer_id = int(id_raw)
        if source_table in ("computers", "hardware", "software") and title:
            hostname = title.split("—")[0].strip() or title
        else:
            hm = re.search(r"\*\*Hostname(?:\s*ПК)?:\*\*\s*(.+)", section, re.IGNORECASE)
            if hm:
                hostname = hm.group(1).strip() or None
            cid_m = re.search(r"\*\*computer_id:\*\*\s*(\d+)", section, re.IGNORECASE)
            if cid_m and computer_id is None:
                computer_id = int(cid_m.group(1))

        body = f"[CORAX:{source_table}] файл={filename}\n{section}"
        if len(body) <= size_limit:
            pieces = [body]
        else:
            header_line = section.split("\n", 1)[0]
            rest = section[len(header_line) :].lstrip("\n")
            sub = chunk_text(rest, size=chunk_size(), overlap=chunk_overlap())
            if not sub:
                pieces = [body]
            else:
                pieces = [
                    f"[CORAX:{source_table}] файл={filename}\n{header_line}\n{p.text}" for p in sub
                ]

        offset = start
        for piece in pieces:
            chunks.append(
                TextChunk(
                    text=piece,
                    char_start=offset,
                    char_end=offset + len(piece),
                    source_kind="corax",
                    source_table=source_table,
                    hostname=hostname,
                    computer_id=computer_id,
                    snapshot_at=snapshot_at,
                    meta={"filename": filename, "section": title},
                )
            )
            offset += len(piece) + 1
    return chunks


def chunk_csv_rows(text: str, *, filename: str) -> list[TextChunk]:
    """Index non-CORAX CSV files row-by-row so exact values remain retrievable."""
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    try:
        dialect = csv.Sniffer().sniff(raw[:4096], delimiters=";,\t")
    except csv.Error:
        dialect = csv.excel
        dialect.delimiter = ";"
    rows = list(csv.reader(io.StringIO(raw), dialect=dialect))
    if not rows:
        return []
    header = [(item or "").strip() for item in rows[0]]
    if not any(header):
        return chunk_text(raw)
    chunks: list[TextChunk] = []
    offset = 0
    for row_index, row in enumerate(rows[1:], start=1):
        values = list(row) + [""] * max(0, len(header) - len(row))
        pairs = [f"{col}={values[i].strip()}" for i, col in enumerate(header) if col and values[i].strip()]
        if not pairs:
            continue
        content = f"[CSV] файл={filename}; строка={row_index}\n" + "; ".join(pairs)
        chunks.append(
            TextChunk(
                text=content,
                char_start=offset,
                char_end=offset + len(content),
                meta={"filename": filename, "row_start": row_index, "row_end": row_index},
            )
        )
        offset += len(content) + 1
    return chunks or chunk_text(raw)


def prepare_document_chunks(
    filename: str,
    kind: str,
    text: str,
    *,
    path: Path | None = None,
) -> list[TextChunk]:
    """Выбор стратегии чанкования: CORAX MD по секциям, CSV построчно, прочее — chunk_text."""
    fn = _normalize_filename(filename)
    snapshot_at = _snapshot_from_path(path)

    if fn in ("CORAX_README.md", "00_system_index.md"):
        parsed = _parse_snapshot_from_readme(text)
        if parsed is not None:
            snapshot_at = parsed
        return [
            TextChunk(
                text=p.text,
                char_start=p.char_start,
                char_end=p.char_end,
                source_kind="corax",
                source_table="readme",
                snapshot_at=snapshot_at,
            )
            for p in chunk_text(text or "")
        ]

    source_table = CORAX_FILENAME_TO_TABLE.get(fn)
    if source_table and fn.lower().endswith(".md"):
        return chunk_corax_markdown(
            text,
            source_table=source_table,
            filename=fn,
            snapshot_at=snapshot_at,
        )
    if source_table and fn.lower().endswith(".csv"):
        return chunk_corax_csv(
            text,
            source_table=source_table,
            filename=fn,
            snapshot_at=snapshot_at,
        )
    if fn.lower().endswith(".csv"):
        return chunk_csv_rows(text, filename=fn)

    return [
        TextChunk(text=p.text, char_start=p.char_start, char_end=p.char_end)
        for p in chunk_text(text or "")
    ]


def _encode_embedding(vec: list[float]) -> str:
    return json.dumps(vec, separators=(",", ":"))


def _decode_embedding(raw: str | None) -> list[float] | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, list) or not data:
        return None
    try:
        return [float(x) for x in data]
    except (TypeError, ValueError):
        return None


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def _ollama_root(base_v1: str) -> str:
    b = base_v1.rstrip("/")
    if b.lower().endswith("/v1"):
        return b[:-3].rstrip("/") or b
    return b


def _parse_openai_embeddings(payload: Any, expected: int) -> list[list[float]] | None:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or len(data) != expected:
        return None
    ordered = sorted(data, key=lambda row: int(row.get("index", 0)))
    out: list[list[float]] = []
    for row in ordered:
        emb = row.get("embedding")
        if not isinstance(emb, list):
            return None
        out.append([float(x) for x in emb])
    return out


def _parse_ollama_embed_batch(payload: Any, expected: int) -> list[list[float]] | None:
    """Ollama /api/embed returns embeddings: [[...], ...] (or singular embedding)."""
    if not isinstance(payload, dict):
        return None
    embs = payload.get("embeddings")
    if isinstance(embs, list) and len(embs) == expected and all(isinstance(e, list) for e in embs):
        return [[float(x) for x in e] for e in embs]
    if expected == 1:
        emb = payload.get("embedding")
        if isinstance(emb, list):
            return [[float(x) for x in emb]]
    return None


async def _embed_openai_batches(
    client: httpx.AsyncClient,
    base: str,
    model: str,
    texts: list[str],
    *,
    batch: int,
) -> tuple[list[list[float]] | None, Exception | None]:
    out: list[list[float]] = []
    for i in range(0, len(texts), batch):
        part = texts[i : i + batch]
        try:
            resp = await client.post(
                f"{base}/embeddings",
                json={"model": model, "input": part if len(part) > 1 else part[0]},
            )
            if resp.status_code >= 400:
                return None, RuntimeError(f"embeddings HTTP {resp.status_code}: {resp.text[:300]}")
            parsed = _parse_openai_embeddings(resp.json(), len(part))
            if parsed is None:
                return None, RuntimeError("embeddings: неожиданный ответ /v1/embeddings")
            out.extend(parsed)
        except (httpx.HTTPError, TypeError, ValueError, KeyError) as e:
            return None, e
    return out, None


async def _embed_ollama_native(
    client: httpx.AsyncClient,
    root: str,
    model: str,
    texts: list[str],
    *,
    batch: int,
) -> list[list[float]]:
    """Prefer Ollama /api/embed (batched), then concurrent /api/embeddings."""
    import asyncio

    out: list[list[float]] = []
    # Newer Ollama: POST /api/embed {"model","input":[...]}
    for i in range(0, len(texts), batch):
        part = texts[i : i + batch]
        resp = await client.post(
            f"{root}/api/embed",
            json={"model": model, "input": part if len(part) > 1 else part[0]},
        )
        if resp.status_code < 400:
            parsed = _parse_ollama_embed_batch(resp.json(), len(part))
            if parsed is not None:
                out.extend(parsed)
                continue
        # Batch endpoint unavailable — fall through to legacy path for remaining.
        remaining = texts[i:]
        break
    else:
        return out

    # Legacy: one prompt per call, but run several in parallel (like LangChain throughput).
    sem = asyncio.Semaphore(8)
    legacy_out: list[list[float] | None] = [None] * len(remaining)

    async def _one(idx: int, text: str) -> None:
        async with sem:
            resp = await client.post(
                f"{root}/api/embeddings",
                json={"model": model, "prompt": text},
            )
            resp.raise_for_status()
            payload = resp.json()
            emb = payload.get("embedding") if isinstance(payload, dict) else None
            if not isinstance(emb, list):
                raise RuntimeError("Ollama embeddings response missing embedding")
            legacy_out[idx] = [float(x) for x in emb]

    await asyncio.gather(*(_one(j, t) for j, t in enumerate(remaining)))
    for vec in legacy_out:
        if vec is None:
            raise RuntimeError("Ollama embeddings: incomplete batch")
        out.append(vec)
    return out


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed texts via OpenAI-compatible /v1/embeddings, with Ollama native fallback.

    Matches LangChain OllamaEmbeddings throughput: large batches + /api/embed when available.
    """
    if not texts:
        return []
    base = embed_base_url()
    model = embed_model()
    # Script uses timeout=120; large bge-m3 batches need headroom.
    timeout = httpx.Timeout(connect=5.0, read=120.0, write=60.0, pool=10.0)
    last_err: Exception | None = None
    batch = 64

    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        vectors, err = await _embed_openai_batches(client, base, model, texts, batch=batch)
        if vectors is not None and len(vectors) == len(texts):
            return vectors
        last_err = err

        root = _ollama_root(base)
        try:
            return await _embed_ollama_native(client, root, model, texts, batch=batch)
        except Exception as e:
            last_err = e

    hint = (
        f"Нет связи с моделью эмбеддингов ({base}, model={model}). "
        "Запустите LM Studio/Ollama с моделью embeddings (например bge-m3) "
        "или проверьте WIKI_RAG_EMBED_BASE_URL / LM_STUDIO_BASE_URL."
    )
    raise RuntimeError(f"{hint} Детали: {last_err}") from last_err


async def embed_query(question: str) -> list[float]:
    vecs = await embed_texts([(question or "").strip() or " "])
    return vecs[0]


def _doc_storage_path(row: WikiRagDocument) -> Path:
    base = (settings.wiki_rag_dir or "wiki_rag_docs").strip() or "wiki_rag_docs"
    root = Path(base)
    if not root.is_absolute():
        root = Path(__file__).resolve().parent.parent / root
    rel = str(row.stored_filename or "").replace("\\", "/").strip("/")
    return root / rel if rel else root


def _meta_json(piece: TextChunk) -> str | None:
    if not piece.meta:
        return None
    try:
        return json.dumps(piece.meta, ensure_ascii=False)
    except (TypeError, ValueError):
        return None


def _make_wiki_chunk(
    doc_id: int,
    piece: TextChunk,
    chunk_index: int,
    emb: list[float] | None,
    model: str | None,
) -> WikiRagChunk:
    return WikiRagChunk(
        document_id=doc_id,
        chunk_index=chunk_index,
        content=piece.text,
        embedding=_encode_embedding(emb) if emb else None,
        embedding_model=model,
        char_start=piece.char_start,
        char_end=piece.char_end,
        source_kind=piece.source_kind,
        source_table=piece.source_table,
        hostname=piece.hostname,
        computer_id=piece.computer_id,
        snapshot_at=piece.snapshot_at,
        meta_json=_meta_json(piece),
    )


async def _store_russian_search_vector(db: AsyncSession, chunk_id: int, content: str) -> None:
    """Keep lexical retrieval available even when embeddings are offline."""
    if db.get_bind().dialect.name != "postgresql":
        return
    await db.execute(
        text(
            "UPDATE wiki_rag_chunks "
            "SET search_vector = to_tsvector('russian', :content) "
            "WHERE id = :id"
        ),
        {"id": chunk_id, "content": content},
    )


async def _refresh_search_vectors_for_document(db: AsyncSession, doc_id: int) -> None:
    """One UPDATE for all chunks of a document (avoids N round-trips)."""
    if db.get_bind().dialect.name != "postgresql":
        return
    await db.execute(
        text(
            "UPDATE wiki_rag_chunks "
            "SET search_vector = to_tsvector('russian', content) "
            "WHERE document_id = :doc_id"
        ),
        {"doc_id": int(doc_id)},
    )


async def _persist_chunks(
    db: AsyncSession,
    doc_id: int,
    pieces: list[TextChunk],
    embeddings: list[list[float] | None],
    model: str | None,
) -> int:
    """Bulk-insert chunks then batch-update FTS + pgvector (Chroma.from_documents-style)."""
    dims = embed_dims()
    rows: list[WikiRagChunk] = []
    for i, (piece, emb) in enumerate(zip(pieces, embeddings)):
        ch = _make_wiki_chunk(doc_id, piece, i, emb, model)
        db.add(ch)
        rows.append(ch)
    await db.flush()

    await _refresh_search_vectors_for_document(db, doc_id)

    vec_pairs: list[tuple[int, list[float]]] = []
    vectors_ok = 0
    for ch, emb in zip(rows, embeddings):
        if not emb:
            continue
        if len(emb) == dims:
            vec_pairs.append((int(ch.id), emb))
            vectors_ok += 1
        else:
            # Dim mismatch — JSON embedding still present on the row
            vectors_ok += 1
    if vec_pairs:
        await store_embedding_vecs_bulk(db, vec_pairs)
    return vectors_ok


async def index_document(db: AsyncSession, doc_id: int) -> WikiRagDocument:
    row = await db.get(WikiRagDocument, doc_id)
    if row is None:
        raise ValueError(f"document {doc_id} not found")

    row.index_status = INDEX_PENDING
    row.index_error = None
    await db.commit()

    path = _doc_storage_path(row)
    try:
        if not path.is_file():
            raise FileNotFoundError("Файл на диске не найден")
        kind, text, _ = extract_plaintext(path, row.original_filename, for_index=True)
        if kind == "image":
            pieces = []
        elif kind == "binary" and not (text or "").strip():
            pieces = []
        else:
            pieces = prepare_document_chunks(row.original_filename, kind, text or "", path=path)

        await db.execute(delete(WikiRagChunk).where(WikiRagChunk.document_id == doc_id))

        if not pieces:
            row.chunk_count = 0
            row.index_status = INDEX_READY
            row.index_error = None
            row.indexed_at = datetime.now(timezone.utc)
            await db.commit()
            await db.refresh(row)
            return row

        embeddings: list[list[float] | None]
        model: str | None = embed_model()
        embed_note: str | None = None
        try:
            embeddings = list(await embed_texts([p.text for p in pieces]))
        except Exception as emb_err:
            log.warning(
                "wikirag_embed_fallback_keyword",
                extra={"document_id": doc_id, "error": str(emb_err)[:500]},
            )
            embeddings = [None] * len(pieces)
            model = None
            embed_note = (
                f"embed:off — чанки без векторов ({embed_model()} недоступна). "
                "Поиск по тексту. Проверьте LM Studio/Ollama и WIKI_RAG_EMBED_MODEL."
            )[:2000]

        vectors_ok = await _persist_chunks(db, doc_id, pieces, embeddings, model)

        row.chunk_count = len(pieces)
        row.index_status = INDEX_READY
        if embed_note:
            row.index_error = embed_note
        elif vectors_ok == 0 and pieces:
            row.index_error = (
                f"embed:off — векторы не записаны (ожидалось {embed_dims()} dims, модель {embed_model()})."
            )[:2000]
        else:
            row.index_error = None
        row.indexed_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(row)
        return row
    except Exception as e:
        log.warning("wikirag_index_failed", extra={"document_id": doc_id, "error": str(e)})
        try:
            await db.rollback()
        except Exception:
            pass
        row = await db.get(WikiRagDocument, doc_id)
        if row is None:
            raise
        row.index_status = INDEX_ERROR
        row.index_error = str(e)[:2000]
        row.chunk_count = 0
        await db.commit()
        await db.refresh(row)
        return row


async def reindex_all(db: AsyncSession) -> dict[str, int]:
    """Последовательная переиндексация (одна сессия). Для фона — очередь wikirag_index_queue."""
    r = await db.execute(select(WikiRagDocument.id).order_by(WikiRagDocument.id.asc()))
    ids = [int(x) for x in r.scalars().all()]
    ok = 0
    failed = 0
    for doc_id in ids:
        row = await index_document(db, doc_id)
        if row.index_status == INDEX_READY:
            ok += 1
        else:
            failed += 1
    return {"indexed": ok, "failed": failed, "total": len(ids)}


async def index_document_task(doc_id: int) -> None:
    from app.database import AsyncSessionLocal

    try:
        async with AsyncSessionLocal() as db:
            await index_document(db, doc_id)
    except Exception as e:
        log.warning("wikirag_index_task_failed", extra={"document_id": doc_id, "error": str(e)})


async def reindex_all_task() -> None:
    """Enqueue every document onto the serial index queue."""
    from app.database import AsyncSessionLocal
    from app.wikirag_index_queue import wikirag_index_queue

    try:
        async with AsyncSessionLocal() as db:
            r = await db.execute(select(WikiRagDocument.id).order_by(WikiRagDocument.id.asc()))
            ids = [int(x) for x in r.scalars().all()]
    except Exception as e:
        log.warning("wikirag_reindex_all_task_failed", extra={"error": str(e)})
        return
    wikirag_index_queue.enqueue(*ids)


async def reindex_ids_task(ids: list[int]) -> None:
    """Enqueue selected ids (deduped by the queue)."""
    from app.wikirag_index_queue import wikirag_index_queue

    wikirag_index_queue.enqueue(*ids)


async def index_document_keyword_only(db: AsyncSession, doc_id: int) -> WikiRagDocument:
    """Быстрая индексация без вызова embed API (чанки для keyword RAG)."""
    row = await db.get(WikiRagDocument, doc_id)
    if row is None:
        raise ValueError(f"document {doc_id} not found")

    row.index_status = INDEX_PENDING
    row.index_error = None
    await db.commit()

    path = _doc_storage_path(row)
    try:
        if not path.is_file():
            raise FileNotFoundError("Файл на диске не найден")
        kind, text, _ = extract_plaintext(path, row.original_filename, for_index=True)
        if kind == "image" or (kind == "binary" and not (text or "").strip()):
            pieces = []
        else:
            pieces = prepare_document_chunks(row.original_filename, kind, text or "", path=path)

        await db.execute(delete(WikiRagChunk).where(WikiRagChunk.document_id == doc_id))
        for i, piece in enumerate(pieces):
            db.add(_make_wiki_chunk(doc_id, piece, i, None, None))
        await db.flush()
        await _refresh_search_vectors_for_document(db, doc_id)
        row.chunk_count = len(pieces)
        row.index_status = INDEX_READY
        row.index_error = (
            f"embed:off — быстрая индексация без векторов ({embed_model()}). "
            "Нажмите «Переиндексировать» при доступной модели эмбеддингов."
        )[:2000]
        row.indexed_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(row)
        return row
    except Exception as e:
        log.warning("wikirag_index_keyword_failed", extra={"document_id": doc_id, "error": str(e)})
        try:
            await db.rollback()
        except Exception:
            pass
        row = await db.get(WikiRagDocument, doc_id)
        if row is None:
            raise
        row.index_status = INDEX_ERROR
        row.index_error = str(e)[:2000]
        row.chunk_count = 0
        await db.commit()
        await db.refresh(row)
        return row


def _keyword_boost(text: str, filename: str, keywords: set[str]) -> float:
    if not keywords:
        return 0.0
    hay = f"{filename}\n{text}".lower()
    hits = sum(1 for w in keywords if w in hay)
    return hits / max(len(keywords), 1)


@dataclass
class RetrievedChunk:
    document_id: int
    filename: str
    content: str
    score: float
    chunk_index: int
    source_kind: str | None = None
    source_table: str | None = None
    hostname: str | None = None
    computer_id: int | None = None


def _hybrid_score(semantic: float, content: str, filename: str, keywords: set[str]) -> float:
    boost = _keyword_boost(content, filename, keywords)
    return 0.82 * semantic + 0.18 * boost


def _retrieved_from_row(row: dict[str, Any], keywords: set[str]) -> RetrievedChunk:
    filename = str(row.get("filename") or "")
    content = str(row.get("content") or "")
    semantic = float(row.get("score") or 0.0)
    return RetrievedChunk(
        document_id=int(row["document_id"]),
        filename=filename,
        content=content,
        score=_hybrid_score(semantic, content, filename, keywords),
        chunk_index=int(row.get("chunk_index") or 0),
        source_kind=row.get("source_kind"),
        source_table=row.get("source_table"),
        hostname=row.get("hostname"),
        computer_id=int(row["computer_id"]) if row.get("computer_id") is not None else None,
    )


def _retrieved_from_chunk(ch: WikiRagChunk, doc_by_id: dict[int, WikiRagDocument], score: float) -> RetrievedChunk:
    doc = doc_by_id.get(ch.document_id) or ch.document
    return RetrievedChunk(
        document_id=ch.document_id,
        filename=doc.original_filename if doc else "",
        content=ch.content or "",
        score=score,
        chunk_index=int(ch.chunk_index or 0),
        source_kind=ch.source_kind,
        source_table=ch.source_table,
        hostname=ch.hostname,
        computer_id=ch.computer_id,
    )


def _chunk_key(chunk: RetrievedChunk) -> tuple[int, int]:
    return chunk.document_id, chunk.chunk_index


async def _retrieve_keyword_chunks(
    db: AsyncSession,
    question: str,
    doc_ids: list[int],
    doc_by_id: dict[int, WikiRagDocument],
    *,
    top_k: int,
) -> list[RetrievedChunk]:
    """Russian FTS first, with a portable exact-token fallback for embed:off."""
    keywords = context_keywords(question)
    if not keywords:
        return []
    if db.get_bind().dialect.name == "postgresql":
        try:
            rows = (
                await db.execute(
                    text(
                        """
                        SELECT c.document_id, c.chunk_index, c.content, c.source_kind, c.source_table,
                               c.hostname, c.computer_id, d.original_filename AS filename,
                               ts_rank_cd(c.search_vector, plainto_tsquery('russian', :question)) AS score
                        FROM wiki_rag_chunks c
                        JOIN wiki_rag_documents d ON d.id = c.document_id
                        WHERE c.document_id IN :ids
                          AND c.search_vector @@ plainto_tsquery('russian', :question)
                        ORDER BY score DESC, c.document_id, c.chunk_index
                        LIMIT :limit
                        """
                    ).bindparams(bindparam("ids", expanding=True)),
                    {"question": question, "ids": doc_ids, "limit": top_k},
                )
            ).mappings().all()
            if rows:
                return [_retrieved_from_row(dict(row), keywords) for row in rows]
        except Exception as e:
            log.info("wikirag_fts_search_failed", extra={"error": str(e)[:300]})

    r = await db.execute(
        select(WikiRagChunk)
        .where(WikiRagChunk.document_id.in_(doc_ids))
        .options(selectinload(WikiRagChunk.document))
    )
    candidates: list[RetrievedChunk] = []
    for ch in r.scalars().all():
        item = _retrieved_from_chunk(ch, doc_by_id, 0.0)
        hits = _keyword_boost(item.content, item.filename, keywords)
        if hits > 0:
            item.score = hits
            candidates.append(item)
    candidates.sort(key=lambda item: (-item.score, item.document_id, item.chunk_index))
    return candidates[:top_k]


def _rrf_fuse(
    semantic: list[RetrievedChunk],
    lexical: list[RetrievedChunk],
    *,
    top_k: int,
) -> list[RetrievedChunk]:
    """Fuse independent dense and lexical rankings without mixing score scales."""
    merged: dict[tuple[int, int], RetrievedChunk] = {}
    scores: dict[tuple[int, int], float] = {}
    for ranking in (semantic, lexical):
        for rank, item in enumerate(ranking, start=1):
            key = _chunk_key(item)
            merged.setdefault(key, item)
            scores[key] = scores.get(key, 0.0) + 1.0 / (60 + rank)
    out = list(merged.values())
    for item in out:
        item.score = scores[_chunk_key(item)]
    out.sort(key=lambda item: (-item.score, item.document_id, item.chunk_index))
    return out[:top_k]


async def retrieve_relevant_chunks(
    db: AsyncSession,
    question: str,
    documents: list[WikiRagDocument],
    *,
    top_k: int | None = None,
) -> list[RetrievedChunk]:
    """Return RRF-fused dense + Russian lexical results; lexical works without embeddings."""
    if not documents:
        return []
    doc_ids = [d.id for d in documents]
    doc_by_id = {d.id: d for d in documents}
    k = top_k or retrieve_top_k()

    keywords = context_keywords(question)
    lexical = await _retrieve_keyword_chunks(
        db, question, doc_ids, doc_by_id, top_k=max(k * 3, k)
    )
    semantic: list[RetrievedChunk] = []
    try:
        q_vec = await embed_query(question)
        vec_hits = await search_by_vector(db, q_vec, doc_ids, top_k=max(k * 3, k))
        if vec_hits:
            semantic = [_retrieved_from_row(row, keywords) for row in vec_hits]
        else:
            r = await db.execute(
                select(WikiRagChunk)
                .where(WikiRagChunk.document_id.in_(doc_ids))
                .options(selectinload(WikiRagChunk.document))
            )
            for ch in r.scalars().all():
                emb = _decode_embedding(ch.embedding)
                if not emb:
                    continue
                item = _retrieved_from_chunk(ch, doc_by_id, cosine_similarity(q_vec, emb))
                if item.score >= 0.34:
                    semantic.append(item)
            semantic.sort(key=lambda item: (-item.score, item.document_id, item.chunk_index))
            semantic = semantic[: max(k * 3, k)]
    except Exception as e:
        log.info("wikirag_embed_query_failed", extra={"error": str(e)[:300]})
    return _rrf_fuse(semantic, lexical, top_k=k)


def build_context_from_chunks(
    chunks: list[RetrievedChunk],
    *,
    max_chars: int,
    doc_hint_fn: Any = None,
) -> tuple[str, list[dict[str, str | int]]]:
    blocks: list[str] = []
    meta: list[dict[str, str | int]] = []
    used = 0
    seen_meta: set[int] = set()
    for ch in chunks:
        hint = doc_hint_fn(ch.filename) if callable(doc_hint_fn) else "документ"
        table = ch.source_table or "—"
        host = ch.hostname or "—"
        cid = str(ch.computer_id) if ch.computer_id is not None else "—"
        block = (
            f"### doc_id={ch.document_id} | file={ch.filename} | тип={hint} | table={table} "
            f"| host={host} | computer_id={cid} | score={ch.score:.3f} | chunk={ch.chunk_index}\n"
            f"{ch.content}"
        )
        if used + len(block) > max_chars and blocks:
            break
        if used + len(block) > max_chars:
            remain = max_chars - used - 80
            if remain < 120:
                break
            block = block[:remain] + "…"
        blocks.append(block)
        used += len(block)
        if ch.document_id not in seen_meta:
            meta.append({"id": ch.document_id, "filename": ch.filename, "chars": len(ch.content)})
            seen_meta.add(ch.document_id)
        else:
            for m in meta:
                if m["id"] == ch.document_id:
                    m["chars"] = int(m["chars"]) + len(ch.content)
                    break
    return "\n\n".join(blocks), meta
