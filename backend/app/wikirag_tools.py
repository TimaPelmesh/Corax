"""Deterministic WikiRAG tools: search_wiki, query_corax, get_computer, search_*.

Local 3B models often lack reliable function-calling, so the server runs tools
and injects structured results + source citations into the prompt.

Park-wide questions (lists, filters, ticket analysis) must not rely on RAG
top-k alone — embeddings only surface a few similar PC chunks. Live search
tools return a focused selection with totals so the model can reason over
the right subset without dumping all 50+ hosts into the window.
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

from app.models import Computer, NetworkDevice, WikiRagDocument
from app.wikirag_corax import (
    _is_weakest_pc_question,
    _load_snapshot,
    build_inventory_analysis_hint,
    build_weakest_pcs_table,
)
from app.network_classify import infer_network_role
from app.wikirag_index import build_context_from_chunks, retrieve_relevant_chunks
from app.wikirag_lm import QuestionFocus, classify_wikirag_question

# Жёсткий потолок tool-контекста (legacy path). Classic RAG uses retrieve top-k instead.
_TOOL_CONTEXT_MAX_CHARS = 18000
_WIKI_CHUNK_MAX_CHARS = 12000
_WIKI_TOP_K = 15
_SEARCH_PC_LIMIT = 25
_SEARCH_TICKET_LIMIT = 20

_PARK_WIDE_RE = re.compile(
    r"(список|все\s+пк|весь\s+парк|сколько|у\s+кого|каки[ех]\s+пк|по\s+парку|"
    r"сравн|анализ|разбит|распредел|топ\s|слаб|фильтр|найди|покажи\s+пк|"
    r"list\s+pc|how\s+many|which\s+pc|compare|analyze)",
    re.IGNORECASE,
)


_HOSTNAME_RE = re.compile(
    r"\b([A-Za-z0-9][A-Za-z0-9_-]{2,31})\b"
)
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
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


def _pc_card(pc: Computer, *, software_n: int = 12) -> str:
    tags = ", ".join(t.name for t in (pc.tags or [])[:10]) or "—"
    sw = ", ".join((s.name or "") for s in (pc.software or [])[:software_n] if s.name) or "—"
    return (
        f"- computer_id={pc.id} hostname={pc.hostname} os={pc.os_name or '—'} "
        f"ver={pc.os_version or '—'} ram_gb={pc.ram_gb if pc.ram_gb is not None else '—'} "
        f"cpu={pc.cpu or '—'} ip={pc.ip_address or '—'} location={pc.location or '—'} "
        f"tags=[{tags}] software=[{sw}]"
    )


def needs_live_inventory_tools(question: str, focus: QuestionFocus | str) -> bool:
    """Park-wide / filter / ticket analysis — RAG top-k alone is too narrow."""
    if focus in {"os_hardware", "software", "tickets"}:
        return True
    return bool(_PARK_WIDE_RE.search(question or ""))


def _extract_pc_filters(question: str) -> dict[str, Any]:
    low = (question or "").lower()
    filters: dict[str, Any] = {"terms": []}
    if any(k in low for k in ("win11", "win 11", "windows 11", "виндовс 11")):
        filters["os"] = "11"
    elif any(k in low for k in ("win10", "win 10", "windows 10", "виндовс 10")):
        filters["os"] = "10"
    elif "windows" in low or "виндов" in low:
        filters["os"] = "windows"
    elif "linux" in low or "линукс" in low:
        filters["os"] = "linux"
    ram_m = re.search(r"(?:меньше|менее|<|≤)\s*(\d+)\s*(?:гб|gb|ram|озу)?", low)
    if ram_m:
        filters["ram_lt"] = float(ram_m.group(1))
    else:
        ram_m = re.search(r"(?:больше|более|>|≥)\s*(\d+)\s*(?:гб|gb|ram|озу)?", low)
        if ram_m:
            filters["ram_gt"] = float(ram_m.group(1))
        else:
            ram_eq = re.search(r"(\d+)\s*(?:гб|gb)\s*(?:ram|озу|памят)?", low)
            if ram_eq and int(ram_eq.group(1)) in {2, 4, 8, 16, 32, 64}:
                filters["ram_eq"] = float(ram_eq.group(1))
    stop = {
        "какие",
        "какой",
        "какая",
        "покажи",
        "список",
        "компьютер",
        "компьютеры",
        "парк",
        "сколько",
        "есть",
        "у",
        "кого",
        "на",
        "пк",
        "pc",
        "windows",
        "linux",
        "виндовс",
        "заявк",
        "тикет",
        "установлен",
        "установлено",
        "установлена",
        "анализ",
        "сравни",
        "лучше",
        "нужно",
        "можно",
        "меньше",
        "больше",
        "менее",
        "более",
        "памяти",
        "память",
        "озу",
        "гб",
        "gb",
        "ram",
    }
    for tok in re.findall(r"[a-zA-Zа-яА-Я0-9][a-zA-Zа-яА-Я0-9._+-]{2,}", low):
        if tok in stop or tok.isdigit():
            continue
        if tok in {"win10", "win11", "chrome", "firefox", "office", "1с", "1c", "dr.web", "kaspersky"}:
            filters["terms"].append(tok)
        elif len(tok) >= 4 and tok not in filters["terms"]:
            filters["terms"].append(tok)
    filters["terms"] = filters["terms"][:8]
    return filters


def _pc_matches_filters(pc: Computer, filters: dict[str, Any]) -> bool:
    os_blob = f"{pc.os_name or ''} {pc.os_version or ''}".lower()
    want_os = filters.get("os")
    if want_os == "11" and "11" not in os_blob:
        return False
    if want_os == "10" and ("10" not in os_blob or "11" in os_blob):
        return False
    if want_os == "windows" and "win" not in os_blob and "винд" not in os_blob:
        return False
    if want_os == "linux" and "linux" not in os_blob and "ubuntu" not in os_blob and "debian" not in os_blob:
        return False
    ram = pc.ram_gb
    if filters.get("ram_lt") is not None and (ram is None or float(ram) >= float(filters["ram_lt"])):
        return False
    if filters.get("ram_gt") is not None and (ram is None or float(ram) <= float(filters["ram_gt"])):
        return False
    if filters.get("ram_eq") is not None and (ram is None or abs(float(ram) - float(filters["ram_eq"])) > 0.6):
        return False
    terms: list[str] = list(filters.get("terms") or [])
    if not terms:
        return True
    sw = " ".join((s.name or "") for s in (pc.software or [])[:100]).lower()
    tags = " ".join(t.name for t in (pc.tags or [])).lower()
    blob = f"{pc.hostname or ''} {os_blob} {pc.cpu or ''} {pc.location or ''} {sw} {tags}".lower()
    return any(term in blob for term in terms)


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
        card = _pc_card(pc)
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


async def tool_search_computers(db: AsyncSession, question: str) -> tuple[str, list[RagSource]]:
    """Filtered park selection with totals — not RAG's first 2 similar chunks."""
    data = await _load_snapshot(db)
    computers: list[Computer] = list(data.get("computers") or [])
    filters = _extract_pc_filters(question)
    matched = [pc for pc in computers if _pc_matches_filters(pc, filters)]
    # If filters were too aggressive and wiped everything, fall back to full park sample.
    used_fallback = False
    if not matched and (filters.get("os") or filters.get("terms") or filters.get("ram_lt") or filters.get("ram_gt") or filters.get("ram_eq")):
        matched = computers
        used_fallback = True
    elif not matched:
        matched = computers

    if _is_weakest_pc_question(question):
        table = build_weakest_pcs_table(data, limit=12)
        sources = [
            RagSource(
                kind="corax_tool",
                label=f"Слабые ПК ({min(12, len(computers))} из {len(computers)})",
                source_table="computers",
                excerpt=table[:220],
            )
        ]
        return f"### tool:search_computers\n{table}", sources

    show = matched[:_SEARCH_PC_LIMIT]
    lines = [
        "### tool:search_computers",
        f"Всего в парке: {len(computers)}. Под фильтр попало: {len(matched)}"
        + (" (фильтр смягчён — показана выборка парка)" if used_fallback else "")
        + f". Показано: {len(show)}.",
    ]
    filt_bits = []
    if filters.get("os"):
        filt_bits.append(f"os={filters['os']}")
    if filters.get("ram_lt") is not None:
        filt_bits.append(f"ram<{filters['ram_lt']}")
    if filters.get("ram_gt") is not None:
        filt_bits.append(f"ram>{filters['ram_gt']}")
    if filters.get("ram_eq") is not None:
        filt_bits.append(f"ram≈{filters['ram_eq']}")
    if filters.get("terms"):
        filt_bits.append("terms=" + ",".join(filters["terms"]))
    if filt_bits:
        lines.append("Фильтр: " + "; ".join(filt_bits))
    sources: list[RagSource] = [
        RagSource(
            kind="corax_tool",
            label=f"Выборка ПК {len(show)}/{len(matched)}",
            source_table="computers",
            excerpt=f"park={len(computers)}; matched={len(matched)}",
        )
    ]
    for pc in show:
        card = _pc_card(pc, software_n=8)
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
    if len(matched) > len(show):
        lines.append(f"- … ещё {len(matched) - len(show)} (уточните фильтр: ОС, RAM, ПО, hostname)")
    return "\n".join(lines), sources


async def tool_search_tickets(db: AsyncSession, question: str) -> tuple[str, list[RagSource]]:
    """Focused ticket selection with status/text filters and totals."""
    data = await _load_snapshot(db)
    reqs: list[Any] = list(data.get("requests") or [])
    pc_by_id = data.get("pc_by_id") or {}
    low = (question or "").lower()

    status_want: set[str] = set()
    if any(k in low for k in ("открыт", "open", "активн", "в работе", "in_progress", "принят")):
        status_want.update({"open", "in_progress"})
    if any(k in low for k in ("закрыт", "выполнен", "done", "closed", "решён", "решен")):
        status_want.update({"done", "cancelled"})
    if "отмен" in low:
        status_want.add("cancelled")

    terms = [
        tok
        for tok in re.findall(r"[a-zA-Zа-яА-Я0-9][a-zA-Zа-яА-Я0-9._+-]{2,}", low)
        if tok
        not in {
            "заявк",
            "заявка",
            "заявки",
            "тикет",
            "список",
            "покажи",
            "анализ",
            "какие",
            "открытые",
            "закрытые",
            "все",
        }
        and len(tok) >= 3
    ][:8]

    matched: list[Any] = []
    for req in reqs:
        status = str(getattr(req, "status", None) or "").lower()
        if status_want and status not in status_want:
            continue
        title = str(getattr(req, "title", None) or "")
        desc = str(getattr(req, "description", None) or "")
        cid = getattr(req, "computer_id", None)
        host = ""
        if cid is not None and cid in pc_by_id:
            host = str(getattr(pc_by_id[cid], "hostname", None) or "")
        blob = f"{title} {desc} {host} {getattr(req, 'requester_name', '') or ''}".lower()
        if terms and not any(t in blob for t in terms):
            continue
        matched.append(req)

    if not matched and (status_want or terms):
        matched = list(reqs)

    # Prefer active tickets first for analysis.
    def _rank(req: Any) -> tuple[int, int]:
        st = str(getattr(req, "status", None) or "")
        prio = {"high": 0, "normal": 1, "low": 2}.get(str(getattr(req, "priority", None) or "normal"), 1)
        order = 0 if st in {"open", "in_progress"} else 1
        return (order, prio)

    matched.sort(key=_rank)
    show = matched[:_SEARCH_TICKET_LIMIT]
    lines = [
        "### tool:search_tickets",
        f"Всего заявок в снимке: {len(reqs)}. Под фильтр: {len(matched)}. Показано: {len(show)}.",
    ]
    if status_want:
        lines.append("Статусы: " + ", ".join(sorted(status_want)))
    if terms:
        lines.append("Термины: " + ", ".join(terms))
    sources: list[RagSource] = [
        RagSource(
            kind="corax_tool",
            label=f"Заявки {len(show)}/{len(matched)}",
            source_table="tickets",
            excerpt=f"total={len(reqs)}; matched={len(matched)}",
        )
    ]
    for req in show:
        title = getattr(req, "title", None) or ""
        status = getattr(req, "status", None) or ""
        prio = getattr(req, "priority", None) or ""
        cid = getattr(req, "computer_id", None)
        host = ""
        if cid is not None and cid in pc_by_id:
            host = getattr(pc_by_id[cid], "hostname", None) or ""
        tid = getattr(req, "ticket_no", None) or getattr(req, "id", None) or "?"
        line = f"- #{tid} [{status}/{prio}] {title}" + (f" · {host}" if host else "")
        lines.append(line)
        sources.append(
            RagSource(
                kind="corax_tool",
                label=f"Заявка #{tid}",
                hostname=host or None,
                computer_id=int(cid) if cid is not None else None,
                source_table="tickets",
                excerpt=line[:220],
            )
        )
    if len(matched) > len(show):
        lines.append(f"- … ещё {len(matched) - len(show)}")
    return "\n".join(lines), sources


def _guess_ips(question: str) -> list[str]:
    return list(dict.fromkeys(_IPV4_RE.findall(question or "")))


def _net_card(dev: NetworkDevice) -> str:
    role = infer_network_role(
        hostname=dev.hostname,
        sys_name=dev.sys_name,
        device_type=dev.device_type,
        source=dev.source,
        extras_json=getattr(dev, "extras_json", None),
    )
    return (
        f"- network_id={dev.id} hostname={dev.hostname or '—'} sysName={dev.sys_name or '—'} "
        f"ip={dev.ip_address or '—'} type={dev.device_type or '—'} role={role} "
        f"vendor={dev.vendor or '—'} snmp={dev.snmp_status or '—'} location={dev.location or '—'}"
    )


async def tool_get_network_device(db: AsyncSession, needles: list[str]) -> tuple[str, list[RagSource]]:
    tokens = [n.strip() for n in needles if n and n.strip()]
    if not tokens:
        return "", []
    clauses = []
    for tok in tokens[:12]:
        clauses.append(NetworkDevice.ip_address == tok)
        clauses.append(NetworkDevice.hostname.ilike(tok))
        clauses.append(NetworkDevice.sys_name.ilike(tok))
        if tok.isdigit():
            clauses.append(NetworkDevice.id == int(tok))
        elif "%" not in tok:
            clauses.append(NetworkDevice.hostname.ilike(f"%{tok}%"))
            clauses.append(NetworkDevice.sys_name.ilike(f"%{tok}%"))
    r = await db.execute(select(NetworkDevice).where(or_(*clauses)).limit(16))
    rows = list(r.scalars().all())
    if not rows:
        return "", []
    lines: list[str] = ["### tool:get_network_device"]
    sources: list[RagSource] = []
    for dev in rows:
        card = _net_card(dev)
        lines.append(card)
        sources.append(
            RagSource(
                kind="corax_tool",
                label=f"Сеть {dev.hostname or dev.ip_address or dev.id}",
                hostname=dev.hostname,
                source_table="network",
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
            parts.append(build_weakest_pcs_table(data, limit=12))
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
        parts.append(f"Всего ПК: {len(computers)} — детальная выборка в tool:search_computers.")
        return "\n".join(parts), sources

    if focus == "tickets":
        reqs = data.get("requests") or []
        by_status: dict[str, int] = {}
        for req in reqs:
            st = str(getattr(req, "status", None) or "unknown")
            by_status[st] = by_status.get(st, 0) + 1
        parts.append(f"Заявок в снимке: {len(reqs)}")
        if by_status:
            parts.append("По статусам: " + ", ".join(f"{k}={v}" for k, v in sorted(by_status.items())))
        parts.append("Детальная выборка — в tool:search_tickets.")
        return "\n".join(parts), sources

    if focus == "network":
        devices: list[NetworkDevice] = data.get("network_devices") or []
        sources[0].excerpt = f"focus=network; devices={len(devices)}"
        sources[0].label = f"Живой снимок сети ({len(devices)} устройств)"
        sources[0].source_table = "network"
        parts.append(f"Сетевых устройств в снимке: {len(devices)}")
        ips = set(_guess_ips(question))
        qlow = question.lower()
        pinned: list[NetworkDevice] = []
        rest: list[NetworkDevice] = []
        for dev in devices:
            ip = str(dev.ip_address or "")
            blob = f"{dev.hostname or ''} {dev.sys_name or ''} {ip} {dev.device_type or ''}".lower()
            if ip in ips or (qlow and any(tok in blob for tok in qlow.split() if len(tok) >= 3)):
                pinned.append(dev)
            else:
                rest.append(dev)
        show = (pinned + rest)[:80]
        parts.append("Каталог IP · имя · тип · SNMP:")
        for dev in show:
            parts.append(_net_card(dev))
        if len(devices) > 80:
            parts.append(f"- … ещё {len(devices) - 80}")
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
    if include_corax and focus in {"os_hardware", "network", "tickets", "software"}:
        corax_block, corax_sources = await tool_query_corax(db, q)
        if corax_block:
            pack.tools_used.append("query_corax")
            blocks.append(corax_block)
            pack.sources.extend(corax_sources)

    # Focused live selections: keep the model's attention on a filtered subset.
    if include_corax and focus in {"os_hardware", "software", "general"} and needs_live_inventory_tools(q, focus):
        search_block, search_sources = await tool_search_computers(db, q)
        if search_block:
            pack.tools_used.append("search_computers")
            blocks.append(search_block)
            pack.sources.extend(search_sources)

    if include_corax and focus == "tickets":
        ticket_block, ticket_sources = await tool_search_tickets(db, q)
        if ticket_block:
            pack.tools_used.append("search_tickets")
            blocks.append(ticket_block)
            pack.sources.extend(ticket_sources)

    # Wiki chunks по индексу (эмбеддинги / hybrid) — не целые файлы.
    skip_wiki = include_corax and focus in {"os_hardware", "tickets"} and (
        _is_weakest_pc_question(q) or needs_live_inventory_tools(q, focus)
    )
    if not skip_wiki:
        wiki_block, wiki_sources = await tool_search_wiki(db, q, wiki_documents)
        if wiki_block:
            pack.tools_used.append("search_wiki")
            blocks.append(wiki_block)
            pack.sources.extend(wiki_sources)

    if include_corax:
        data = await _load_snapshot(db)
        computers: list[Computer] = data["computers"]
        devices: list[NetworkDevice] = data.get("network_devices") or []
        known = {str(pc.hostname) for pc in computers if pc.hostname}
        known.update(str(d.hostname) for d in devices if d.hostname)
        known.update(str(d.sys_name) for d in devices if d.sys_name)
        hosts = _guess_hostnames(q, known)
        ips = _guess_ips(q)

        if hosts:
            card_block, card_sources = await tool_get_computer(db, hosts)
            if card_block:
                pack.tools_used.append("get_computer")
                blocks.append(card_block)
                pack.sources.extend(card_sources)

        net_needles = list(dict.fromkeys([*ips, *hosts]))
        if net_needles:
            net_block, net_sources = await tool_get_network_device(db, net_needles)
            if net_block:
                pack.tools_used.append("get_network_device")
                blocks.append(net_block)
                pack.sources.extend(net_sources)

        if "query_corax" not in pack.tools_used:
            corax_block, corax_sources = await tool_query_corax(db, q)
            if corax_block:
                pack.tools_used.append("query_corax")
                blocks.append(corax_block)
                pack.sources.extend(corax_sources)

        pack.stats["computers"] = len(computers)
        pack.stats["network_devices"] = len(devices)
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
