"""Deterministic WikiRAG tools: search_wiki, query_corax, get_computer.

Local 3B models often lack reliable function-calling, so the server runs tools
and injects structured results + source citations into the prompt.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Computer, WikiRagDocument
from app.wikirag_corax import (
    _is_weakest_pc_question,
    _load_snapshot,
    build_inventory_analysis_hint,
    build_weakest_pcs_table,
)
from app.wikirag_index import build_context_from_chunks, retrieve_relevant_chunks
from app.wikirag_lm import classify_wikirag_question

# Жёсткий потолок tool-контекста (legacy path). Classic RAG uses retrieve top-k instead.
_TOOL_CONTEXT_MAX_CHARS = 18000
_WIKI_CHUNK_MAX_CHARS = 12000
_WIKI_TOP_K = 15


_HOSTNAME_RE = re.compile(
    r"\b([A-Za-z0-9][A-Za-z0-9_-]{2,31})\b"
)
_NOISE_HOST = {
    "win10",
    "win11",
    "windows",
    "linux",
    "кому",
    "лучше",
    "ставить",
    "обновить",
    "принтер",
    "corax",
    "wiki",
    "rag",
}


@dataclass
class RagSource:
    kind: str  # wiki_chunk | corax_live | corax_tool
    label: str
    document_id: int | None = None
    filename: str | None = None
    chunk_index: int | None = None
    hostname: str | None = None
    computer_id: int | None = None
    source_table: str | None = None
    score: float | None = None
    excerpt: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        if self.score is not None:
            d["score"] = round(float(self.score), 4)
        return {k: v for k, v in d.items() if v is not None and v != ""}


@dataclass
class ToolPack:
    context: str
    sources: list[RagSource] = field(default_factory=list)
    tools_used: list[str] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)

    def sources_for_api(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for s in self.sources[:24]:
            item: dict[str, Any] = {
                "kind": s.kind,
                "label": s.label,
                "excerpt": (s.excerpt or "")[:280],
            }
            if s.document_id is not None:
                item["document_id"] = s.document_id
            if s.filename:
                item["filename"] = s.filename
            if s.chunk_index is not None:
                item["chunk_index"] = s.chunk_index
            if s.hostname:
                item["hostname"] = s.hostname
            if s.computer_id is not None:
                item["computer_id"] = s.computer_id
            if s.source_table:
                item["source_table"] = s.source_table
            if s.score is not None:
                item["score"] = round(float(s.score), 4)
            out.append(item)
        return out


def _guess_hostnames(question: str, known: set[str]) -> list[str]:
    q = question or ""
    hits: list[str] = []
    lower_known = {h.lower(): h for h in known if h}
    for m in _HOSTNAME_RE.finditer(q):
        token = m.group(1)
        low = token.lower()
        if low in _NOISE_HOST or len(low) < 3:
            continue
        if low in lower_known:
            hits.append(lower_known[low])
        elif "-" in token or token.upper() == token or re.search(r"\d", token):
            # Likely hostname-ish even if not in inventory yet
            if token not in hits:
                hits.append(token)
    # Also substring match for known hostnames
    q_low = q.lower()
    for h in known:
        if h and h.lower() in q_low and h not in hits:
            hits.append(h)
    return hits[:8]


async def tool_search_wiki(
    db: AsyncSession,
    question: str,
    documents: list[WikiRagDocument],
    *,
    top_k: int = _WIKI_TOP_K,
) -> tuple[str, list[RagSource]]:
    if not documents:
        return "", []
    ranked = await retrieve_relevant_chunks(db, question, documents, top_k=top_k)
    if not ranked:
        return "", []
    block, _meta = build_context_from_chunks(ranked, max_chars=_WIKI_CHUNK_MAX_CHARS)
    sources = [
        RagSource(
            kind="wiki_chunk",
            label=f"{ch.filename} · chunk {ch.chunk_index}",
            document_id=ch.document_id,
            filename=ch.filename,
            chunk_index=ch.chunk_index,
            hostname=getattr(ch, "hostname", None),
            computer_id=getattr(ch, "computer_id", None),
            source_table=getattr(ch, "source_table", None),
            score=ch.score,
            excerpt=(ch.content or "")[:220],
        )
        for ch in ranked
    ]
    return f"### tool:search_wiki\n{block}", sources


async def tool_get_computer(db: AsyncSession, hostnames: list[str]) -> tuple[str, list[RagSource]]:
    if not hostnames:
        return "", []
    clauses = [Computer.hostname.ilike(h) for h in hostnames]
    # also exact id if numeric
    for h in hostnames:
        if h.isdigit():
            clauses.append(Computer.id == int(h))
    r = await db.execute(
        select(Computer)
        .where(or_(*clauses))
        .options(selectinload(Computer.tags), selectinload(Computer.software))
        .limit(12)
    )
    pcs = list(r.scalars().unique().all())
    if not pcs:
        return "", []
    lines: list[str] = ["### tool:get_computer"]
    sources: list[RagSource] = []
    for pc in pcs:
        tags = ", ".join(t.name for t in (pc.tags or [])[:12]) or "—"
        sw = ", ".join((s.name or "") for s in (pc.software or [])[:20] if s.name) or "—"
        card = (
            f"- computer_id={pc.id} hostname={pc.hostname} os={pc.os_name or '—'} "
            f"ver={pc.os_version or '—'} ram_gb={pc.ram_gb if pc.ram_gb is not None else '—'} "
            f"cpu={pc.cpu or '—'} ip={pc.ip_address or '—'} location={pc.location or '—'} "
            f"tags=[{tags}] software=[{sw}]"
        )
        lines.append(card)
        sources.append(
            RagSource(
                kind="corax_tool",
                label=f"ПК {pc.hostname}",
                hostname=pc.hostname,
                computer_id=pc.id,
                source_table="computers",
                excerpt=card[:220],
            )
        )
    return "\n".join(lines), sources


async def tool_query_corax(db: AsyncSession, question: str) -> tuple[str, list[RagSource]]:
    data = await _load_snapshot(db)
    focus = classify_wikirag_question(question)
    computers: list[Computer] = data["computers"]
    sources: list[RagSource] = [
        RagSource(
            kind="corax_live",
            label=f"Живой снимок CORAX ({len(computers)} ПК)",
            source_table="snapshot",
            excerpt=f"focus={focus}; pcs={len(computers)}",
        )
    ]
    parts: list[str] = [f"### tool:query_corax focus={focus}"]

    if focus == "software":
        # Факты для модели, не готовый ответ пользователю.
        terms_blob = question.lower()
        hits: list[str] = []
        for pc in computers:
            names = " ".join((s.name or "") for s in (pc.software or [])[:80])
            if any(tok in names.lower() for tok in terms_blob.split() if len(tok) >= 3):
                hits.append(f"{pc.hostname}: {names[:180]}")
            if len(hits) >= 25:
                break
        if hits:
            parts.append("Совпадения ПО (фрагменты):\n" + "\n".join(f"- {h}" for h in hits))
        else:
            parts.append(
                f"В снимке {len(computers)} ПК с ПО. Ниже — первые hostname для ориентира: "
                + ", ".join(pc.hostname for pc in computers[:20] if pc.hostname)
            )
        return "\n".join(parts), sources

    if focus == "os_hardware":
        if _is_weakest_pc_question(question):
            parts.append(build_weakest_pcs_table(data, limit=8))
            return "\n".join(parts), sources
        hint = build_inventory_analysis_hint(data, question)
        if hint:
            parts.append(hint)
        hist: dict[str, int] = {}
        for pc in computers:
            key = (pc.os_name or "неизвестно").strip() or "неизвестно"
            hist[key] = hist.get(key, 0) + 1
        top = sorted(hist.items(), key=lambda x: -x[1])[:8]
        parts.append("ОС в парке: " + ", ".join(f"{k}={v}" for k, v in top))
        return "\n".join(parts), sources

    if focus == "tickets":
        reqs = data.get("requests") or []
        pc_by_id = data.get("pc_by_id") or {}
        parts.append(f"Заявок в снимке: {len(reqs)}")
        for req in reqs[:15]:
            title = getattr(req, "title", None) or ""
            status = getattr(req, "status", None) or ""
            cid = getattr(req, "computer_id", None)
            host = ""
            if cid is not None and cid in pc_by_id:
                host = getattr(pc_by_id[cid], "hostname", None) or ""
            parts.append(f"- [{status}] {title} · {host}".strip())
        return "\n".join(parts), sources

    # general: short park stats
    parts.append(
        f"Парк: {len(computers)} ПК, тегов={len(data.get('tags') or [])}, "
        f"заявок={len(data.get('requests') or [])}, принтеров={len(data.get('printers') or [])}."
    )
    return "\n".join(parts), sources


async def run_wikirag_tools(
    db: AsyncSession,
    question: str,
    *,
    wiki_documents: list[WikiRagDocument],
    include_corax: bool = True,
) -> ToolPack:
    pack = ToolPack(context="")
    blocks: list[str] = []
    q = (question or "").strip()
    if not q:
        return pack

    focus = classify_wikirag_question(q)
    # Для «топ слабых / железо» сначала живой рейтинг CORAX — wiki CSV только как дополнение.
    if include_corax and focus == "os_hardware":
        corax_block, corax_sources = await tool_query_corax(db, q)
        if corax_block:
            pack.tools_used.append("query_corax")
            blocks.append(corax_block)
            pack.sources.extend(corax_sources)

    # Wiki chunks по индексу (эмбеддинги / hybrid) — не целые файлы.
    skip_wiki = include_corax and focus == "os_hardware" and _is_weakest_pc_question(q)
    if not skip_wiki:
        wiki_block, wiki_sources = await tool_search_wiki(db, q, wiki_documents)
        if wiki_block:
            pack.tools_used.append("search_wiki")
            blocks.append(wiki_block)
            pack.sources.extend(wiki_sources)

    if include_corax:
        data = await _load_snapshot(db)
        computers: list[Computer] = data["computers"]
        known = {str(pc.hostname) for pc in computers if pc.hostname}
        hosts = _guess_hostnames(q, known)

        if hosts:
            card_block, card_sources = await tool_get_computer(db, hosts)
            if card_block:
                pack.tools_used.append("get_computer")
                blocks.append(card_block)
                pack.sources.extend(card_sources)

        if "query_corax" not in pack.tools_used:
            corax_block, corax_sources = await tool_query_corax(db, q)
            if corax_block:
                pack.tools_used.append("query_corax")
                blocks.append(corax_block)
                pack.sources.extend(corax_sources)

        pack.stats["computers"] = len(computers)
        pack.stats["snapshot_at"] = datetime.now(timezone.utc).isoformat()

    pack.stats["tools"] = list(pack.tools_used)
    pack.stats["sources"] = len(pack.sources)
    kept: list[str] = []
    used = 0
    for block in blocks:
        candidate = len(block) + (2 if kept else 0)
        if used + candidate <= _TOOL_CONTEXT_MAX_CHARS:
            kept.append(block)
            used += candidate
            continue
        # Keep a bounded final fragment instead of slicing through an earlier
        # CSV/wiki chunk that may contain the answer.
        remaining = _TOOL_CONTEXT_MAX_CHARS - used - (2 if kept else 0)
        if remaining >= 240:
            kept.append(block[: remaining - 20].rstrip() + "\n… [обрезано]")
        break
    ctx = "\n\n".join(kept).strip()
    pack.context = ctx
    pack.stats["context_chars"] = len(ctx)
    return pack
