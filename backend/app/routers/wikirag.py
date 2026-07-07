import re
import secrets
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_current_editor_or_superuser, get_current_user
from app.config import settings
from app.database import get_db
from app.models import User, WikiRagDocument
from app.schemas import (
    WikiRagChatPreviewOut,
    WikiRagChatRequest,
    WikiRagChatResponse,
    WikiRagCoraxImportOut,
    WikiRagDocumentContentOut,
    WikiRagDocumentContentUpdate,
    WikiRagDocumentOut,
    WikiRagDocumentUpdate,
    WikiRagLmStudioStatus,
)
from app.wikirag_corax import (
    CORAX_BUNDLE_FILENAMES,
    CORAX_FILE_PREFIX,
    CORAX_IMPORT_COMMENT,
    CORAX_README_FILENAME,
    CoraxLevel,
    build_corax_context_excerpt,
    build_corax_knowledge_bundle,
    pick_corax_level,
)
from app.wikirag_context_budget import (
    chars_for_tokens,
    estimate_messages_tokens,
    prompt_token_budget,
)
from app.wikirag_content import (
    _PREVIEW_MAX_CHARS,
    _truncate,
    excerpt_for_context,
    extract_plaintext,
    image_data_url,
    is_editable_filename,
    read_editable_content,
    write_editable_content,
)
from app.wikirag_lm import (
    build_messages,
    classify_wikirag_question,
    coerce_parsed,
    is_bad_lm_answer,
    is_small_talk,
    normalize_lm_base_url,
    sanitize_chat_history,
    lm_studio_chat,
    lm_studio_health,
    messages_stats,
)

router = APIRouter(prefix="/wiki-rag", tags=["wiki-rag"])

_BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
_MAX_BYTES = 25 * 1024 * 1024
_ALLOWED_EXT = {
    ".pdf",
    ".txt",
    ".md",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
}


def _storage_dir() -> Path:
    base = (settings.wiki_rag_dir or "wiki_rag_docs").strip() or "wiki_rag_docs"
    p = Path(base)
    if not p.is_absolute():
        p = _BACKEND_DIR / p
    p.mkdir(parents=True, exist_ok=True)
    return p


def _safe_stem(name: str) -> str:
    stem = Path(name).stem.strip() or "document"
    stem = re.sub(r"[^\w.\- ]+", "_", stem, flags=re.UNICODE)
    stem = re.sub(r"\s+", " ", stem).strip("._- ")
    return (stem[:180] or "document")


async def _get_doc_row(doc_id: int, db: AsyncSession) -> WikiRagDocument:
    row = await db.get(WikiRagDocument, doc_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Документ не найден")
    path = _storage_dir() / row.stored_filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл на диске не найден")
    return row


def _doc_path(row: WikiRagDocument) -> Path:
    return _storage_dir() / row.stored_filename


def _doc_to_out(row: WikiRagDocument) -> WikiRagDocumentOut:
    uploader = row.uploaded_by
    return WikiRagDocumentOut(
        id=row.id,
        original_filename=row.original_filename,
        mime_type=row.mime_type,
        size_bytes=int(row.size_bytes or 0),
        comment=row.comment,
        uploaded_by_id=row.uploaded_by_id,
        uploaded_by_username=uploader.username if uploader else "?",
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("/lm-studio/status", response_model=WikiRagLmStudioStatus)
async def lm_studio_status(
    _: User = Depends(get_current_user),
    base_url: str | None = Query(default=None, max_length=512),
    model: str | None = Query(default=None, max_length=256),
):
    data = await lm_studio_health(base_url=base_url, preferred_model=model)
    return WikiRagLmStudioStatus(
        ok=bool(data.get("ok")),
        models=list(data.get("models") or []),
        detail=data.get("detail"),
        selected_model=data.get("selected_model"),
        base_url=data.get("base_url"),
    )


@router.post("/import/corax", response_model=WikiRagCoraxImportOut)
async def import_corax_snapshot(
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    bundle, stats = await build_corax_knowledge_bundle(db)
    saved_docs: list[WikiRagDocument] = []
    created_count = 0

    for filename in CORAX_BUNDLE_FILENAMES:
        if filename not in bundle:
            continue
        content = bundle[filename]
        raw = content.encode("utf-8")
        mime = "text/csv" if filename.lower().endswith(".csv") else "text/markdown"
        r = await db.execute(select(WikiRagDocument).where(WikiRagDocument.original_filename == filename))
        row = r.scalar_one_or_none()
        if row is None:
            ext = Path(filename).suffix or ".txt"
            stored = f"{secrets.token_hex(8)}_{_safe_stem(filename)}{ext}"
            dest = _storage_dir() / stored
            dest.write_bytes(raw)
            row = WikiRagDocument(
                original_filename=filename,
                stored_filename=stored,
                mime_type=mime,
                size_bytes=len(raw),
                comment=CORAX_IMPORT_COMMENT,
                uploaded_by_id=current.id,
            )
            db.add(row)
            created_count += 1
        else:
            dest = _storage_dir() / row.stored_filename
            dest.write_bytes(raw)
            row.size_bytes = len(raw)
            row.comment = CORAX_IMPORT_COMMENT
            row.mime_type = mime
        saved_docs.append(row)

    # Удалить устаревший монолитный файл прошлых версий
    legacy_r = await db.execute(
        select(WikiRagDocument).where(WikiRagDocument.original_filename == "CORAX_база_знаний.md")
    )
    for legacy in legacy_r.scalars().all():
        try:
            (_storage_dir() / legacy.stored_filename).unlink(missing_ok=True)
        except OSError:
            pass
        await db.delete(legacy)

    await db.commit()
    for row in saved_docs:
        await db.refresh(row, attribute_names=["uploaded_by"])
        row.uploaded_by = current

    main = next((d for d in saved_docs if d.original_filename == CORAX_README_FILENAME), saved_docs[0])
    return WikiRagCoraxImportOut(
        document=_doc_to_out(main),
        documents=[_doc_to_out(d) for d in saved_docs],
        computers=int(stats.get("computers") or 0),
        requests=int(stats.get("requests") or 0),
        tags=int(stats.get("tags") or 0),
        chars=int(stats.get("chars") or 0),
        files=len(saved_docs),
        created=created_count > 0,
    )


@router.get("", response_model=list[WikiRagDocumentOut])
async def list_documents(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(
        select(WikiRagDocument)
        .options(selectinload(WikiRagDocument.uploaded_by))
        .order_by(WikiRagDocument.id.desc())
    )
    return [_doc_to_out(row) for row in r.scalars().all()]


def _doc_context_hint(filename: str) -> str:
    fn = filename.lower()
    if fn.startswith("corax_") and fn.endswith(".csv"):
        return "таблица CORAX; строки связаны по computer_id и hostname"
    if fn.startswith("corax_"):
        return "справочник CORAX (схема данных)"
    return "документ"


def _doc_excerpt_limit(
    filename: str,
    *,
    max_chars: int | None = None,
    question_focus: str = "general",
) -> int:
    fn = filename.lower()
    cap = max_chars or 10_000
    if fn == "corax_компьютеры.csv" and question_focus == "os_hardware":
        return min(5000, cap)
    if fn.startswith("corax_") and fn.endswith(".csv"):
        return min(1200, cap)
    if fn.startswith("corax_"):
        return min(800, cap)
    return min(900, cap)


def _build_documents_context(
    rows: list[WikiRagDocument],
    *,
    max_chars: int | None = None,
    question_focus: str = "general",
) -> tuple[str, list[dict[str, str | int]]]:
    max_ctx = max_chars
    if max_ctx is None:
        max_ctx = int(getattr(settings, "wiki_rag_chat_context_max_chars", None) or 16_000)
    ordered = sorted(
        rows,
        key=lambda r: (
            0 if (r.original_filename or "").upper().startswith(CORAX_FILE_PREFIX) else 1,
            0 if (r.original_filename or "").lower().endswith(".csv") else 1,
            -(r.id or 0),
        ),
    )
    blocks: list[str] = []
    meta: list[dict[str, str | int]] = []
    used = 0
    for row in ordered:
        path = _doc_path(row)
        if not path.is_file():
            continue
        kind, text, _ = extract_plaintext(path, row.original_filename)
        hint = _doc_context_hint(row.original_filename)
        if kind == "image":
            snippet = "[изображение, текст не извлекается]"
        else:
            snippet = excerpt_for_context(
                text,
                _doc_excerpt_limit(row.original_filename, max_chars=max_ctx, question_focus=question_focus),
            )
        block = (
            f"### doc_id={row.id} | file={row.original_filename} | тип={hint}\n"
            f"{snippet}"
        )
        if used + len(block) > max_ctx:
            break
        blocks.append(block)
        meta.append({"id": row.id, "filename": row.original_filename, "chars": len(snippet)})
        used += len(block)
    return "\n\n".join(blocks), meta


_CORAX_DOC_PRIORITY = (
    "CORAX_ПО.csv",
    "CORAX_заявки.csv",
    "CORAX_компьютеры.csv",
    "CORAX_теги_пк.csv",
    CORAX_README_FILENAME,
)

_HARDWARE_DOC_PRIORITY = (
    "CORAX_компьютеры.csv",
    "CORAX_диски.csv",
    "CORAX_теги_пк.csv",
    CORAX_README_FILENAME,
    "CORAX_ПО.csv",
    "CORAX_заявки.csv",
)


def _doc_priority_for_question(question: str) -> tuple[str, ...]:
    from app.wikirag_lm import classify_wikirag_question

    if classify_wikirag_question(question) == "os_hardware":
        return _HARDWARE_DOC_PRIORITY
    return _CORAX_DOC_PRIORITY


def _has_corax_import_docs(rows: list[WikiRagDocument]) -> bool:
    return any((r.original_filename or "").startswith(CORAX_FILE_PREFIX) for r in rows)


def _prioritize_corax_docs(rows: list[WikiRagDocument], *, question: str = "") -> list[WikiRagDocument]:
    if not rows:
        return rows
    by_name = {r.original_filename: r for r in rows}
    ordered: list[WikiRagDocument] = []
    seen: set[int] = set()
    for name in _doc_priority_for_question(question):
        row = by_name.get(name)
        if row and row.id not in seen:
            ordered.append(row)
            seen.add(row.id)
    for row in rows:
        if row.id not in seen:
            ordered.append(row)
            seen.add(row.id)
    return ordered


async def _prepare_chat_messages(
    q: str,
    document_ids: list[int] | None,
    history: list[dict[str, str]],
    db: AsyncSession,
    *,
    include_corax: bool = True,
) -> tuple[list[dict[str, str]], str, list[dict[str, str | int]], dict[str, Any], str]:
    r = await db.execute(select(WikiRagDocument).order_by(WikiRagDocument.id.desc()))
    rows = list(r.scalars().all())
    if document_ids:
        id_set = set(document_ids)
        rows = [row for row in rows if row.id in id_set]
    elif rows:
        rows = rows[:10]

    mode = "simple" if is_small_talk(q) else "rag"
    question_focus = classify_wikirag_question(q)
    corax_stats: dict[str, Any] = {}
    token_budget = prompt_token_budget()

    if mode == "simple":
        messages = build_messages(q, "", history, mode=mode)
        return messages, mode, [], corax_stats, ""

    has_corax_docs = _has_corax_import_docs(rows)
    if has_corax_docs:
        rows = _prioritize_corax_docs(rows, question=q)

    from app.wikirag_corax import _load_snapshot, build_corax_context_from_data, build_os_hardware_fallback_answer

    corax_data = await _load_snapshot(db) if include_corax else None
    n_pc_hint = len(corax_data["computers"]) if corax_data else 0

    level_order: list[CoraxLevel] = ["micro", "compact", "medium", "full"]
    if include_corax and corax_data is not None:
        start = pick_corax_level(n_pc_hint, has_imported_files=has_corax_docs, question=q)
        start_i = level_order.index(start)
        try_levels = list(reversed(level_order[: start_i + 1]))
    else:
        try_levels = ["micro"]

    messages: list[dict[str, str]] = []
    doc_meta: list[dict[str, str | int]] = []
    used_level: CoraxLevel = "micro"

    corax_fallback = ""
    if corax_data is not None and question_focus == "os_hardware":
        corax_fallback = build_os_hardware_fallback_answer(corax_data, q)

    for level in try_levels:
        corax_block = ""
        if include_corax and corax_data is not None:
            corax_share = 0.72 if question_focus == "os_hardware" else 0.5
            corax_chars = chars_for_tokens(int(token_budget * corax_share))
            corax_block = build_corax_context_from_data(corax_data, corax_chars, level, question=q)
            corax_stats = {
                "computers": n_pc_hint,
                "tags": len(corax_data["tags"]),
                "chars": len(corax_block),
                "level": level,
                "focus": question_focus,
            }
        docs_chars = chars_for_tokens(token_budget - int(token_budget * (0.72 if question_focus == "os_hardware" else 0.5)))
        if has_corax_docs:
            docs_cap = 4000 if question_focus == "os_hardware" else 2800
            docs_chars = min(docs_chars, docs_cap)
        doc_block, doc_meta = _build_documents_context(
            rows, max_chars=docs_chars, question_focus=question_focus
        )
        messages = build_messages(
            q,
            doc_block,
            history,
            corax_block=corax_block,
            mode=mode,
            data_char_budget=chars_for_tokens(token_budget),
            question_focus=question_focus,
        )
        if estimate_messages_tokens(messages) <= token_budget:
            used_level = level
            break
        used_level = level
    else:
        messages = build_messages(
            q, "", history, corax_block="", mode=mode, data_char_budget=800, question_focus=question_focus
        )
        corax_stats = {**corax_stats, "level": "micro", "fallback": True}

    corax_stats["estimated_tokens"] = estimate_messages_tokens(messages)
    corax_stats["token_budget"] = token_budget
    corax_stats["level"] = corax_stats.get("level") or used_level
    if has_corax_docs:
        corax_stats["imported_docs"] = True
    if corax_fallback:
        corax_stats["fallback_ready"] = True
    return messages, mode, doc_meta, corax_stats, corax_fallback


def _resolve_lm_base_url(raw: str | None) -> str | None:
    if raw is None or not str(raw).strip():
        return None
    try:
        return normalize_lm_base_url(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/chat/preview", response_model=WikiRagChatPreviewOut)
async def wiki_rag_chat_preview(
    body: WikiRagChatRequest,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = body.message.strip()
    history = sanitize_chat_history([{"role": m.role, "content": m.content} for m in body.history])
    messages, mode, doc_meta, corax_stats, _corax_fallback = await _prepare_chat_messages(
        q, body.document_ids, history, db, include_corax=body.include_corax
    )
    stats = messages_stats(messages)
    return WikiRagChatPreviewOut(
        mode=mode,
        documents=doc_meta,
        messages=messages,
        total_chars=stats["total_chars"],
        hint=(
            "Режим «simple»: без документов (приветствие и короткие фразы)."
            if mode == "simple"
            else f"Режим «rag»: CORAX {corax_stats.get('computers', 0)} ПК, до {len(doc_meta)} документов."
        ),
    )


@router.post("/chat", response_model=WikiRagChatResponse)
async def wiki_rag_chat(
    body: WikiRagChatRequest,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = body.message.strip()
    history = sanitize_chat_history([{"role": m.role, "content": m.content} for m in body.history])
    messages, mode, doc_meta, corax_stats, corax_fallback = await _prepare_chat_messages(
        q, body.document_ids, history, db, include_corax=body.include_corax
    )
    stats = messages_stats(messages)
    lm_base = _resolve_lm_base_url(body.lm_base_url)
    meta = {
        "mode": mode,
        "total_chars": stats["total_chars"],
        "documents": doc_meta,
        "corax": corax_stats,
        "lm_base_url": lm_base or settings.lm_studio_base_url,
        "proxy_bypass": True,
    }
    try:
        raw, model = await lm_studio_chat(
            messages,
            base_url=lm_base,
            model=body.lm_model,
            mode=mode if mode in ("simple", "rag") else "rag",
        )
        parsed = coerce_parsed(raw)
        if corax_fallback and is_bad_lm_answer(parsed.get("answer") or raw):
            parsed["answer"] = corax_fallback
            parsed["confidence"] = "high"
            parsed["_corax_fallback"] = True
        if corax_stats.get("fallback"):
            parsed["answer"] = (
                str(parsed.get("answer") or "")
                + "\n\n(Контекст был сильно сжат из‑за лимита модели — для точности импортируйте CORAX CSV.)"
            ).strip()
        return WikiRagChatResponse(ok=True, raw=raw, parsed=parsed, model=model, meta=meta)
    except httpx.HTTPError as e:
        shown_url = lm_base or settings.lm_studio_base_url
        return WikiRagChatResponse(
            ok=False,
            error=f"Нет связи с LM Studio ({shown_url}): {e}",
            meta=meta,
        )
    except RuntimeError as e:
        return WikiRagChatResponse(ok=False, error=str(e), meta=meta)
    except Exception as e:
        return WikiRagChatResponse(ok=False, error=str(e), meta=meta)


@router.post("", response_model=WikiRagDocumentOut)
async def upload_document(
    file: UploadFile = File(...),
    comment: str | None = Form(default=None),
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    fn = (file.filename or "").strip()
    if not fn:
        raise HTTPException(status_code=400, detail="Файл не выбран.")
    ext = Path(fn).suffix.lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail=f"Недопустимый тип файла. Разрешены: {', '.join(sorted(_ALLOWED_EXT))}",
        )
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл.")
    if len(raw) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Файл слишком большой. Максимум 25 МБ.")

    stored = f"{secrets.token_hex(8)}_{_safe_stem(fn)}{ext}"
    dest = _storage_dir() / stored
    dest.write_bytes(raw)

    note = (comment or "").strip() or None
    if note and len(note) > 4000:
        note = note[:4000]

    row = WikiRagDocument(
        original_filename=fn[:512],
        stored_filename=stored,
        mime_type=(file.content_type or "").strip()[:128] or None,
        size_bytes=len(raw),
        comment=note,
        uploaded_by_id=current.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row, attribute_names=["uploaded_by"])
    row.uploaded_by = current
    return _doc_to_out(row)


@router.get("/{doc_id}/content", response_model=WikiRagDocumentContentOut)
async def get_document_content(
    doc_id: int,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_doc_row(doc_id, db)
    path = _doc_path(row)
    editable = is_editable_filename(row.original_filename)

    if editable:
        text = read_editable_content(path)
        content, truncated = _truncate(text, _PREVIEW_MAX_CHARS)
        return WikiRagDocumentContentOut(
            id=row.id,
            original_filename=row.original_filename,
            kind="text",
            editable=True,
            content=content,
            truncated=truncated,
            hint=None,
        )

    kind, text, truncated = extract_plaintext(path, row.original_filename)
    if kind == "image":
        data_url = image_data_url(path, row.mime_type)
        return WikiRagDocumentContentOut(
            id=row.id,
            original_filename=row.original_filename,
            kind="image",
            editable=False,
            preview_url=data_url or f"/api/v1/wiki-rag/{row.id}/file",
            truncated=False,
            hint="Изображение" if data_url else "Откройте файл по ссылке скачивания",
        )

    hint = None
    if kind == "binary":
        hint = "Редактирование недоступно для этого формата"
    elif not editable:
        hint = "Только просмотр извлечённого текста"

    return WikiRagDocumentContentOut(
        id=row.id,
        original_filename=row.original_filename,
        kind=kind,
        editable=False,
        content=text or None,
        truncated=truncated,
        hint=hint,
    )


@router.put("/{doc_id}/content", response_model=WikiRagDocumentContentOut)
async def put_document_content(
    doc_id: int,
    body: WikiRagDocumentContentUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_doc_row(doc_id, db)
    if not is_editable_filename(row.original_filename):
        raise HTTPException(status_code=400, detail="Этот тип файла нельзя редактировать в браузере")
    path = _doc_path(row)
    try:
        size = write_editable_content(path, body.content)
    except ValueError as e:
        raise HTTPException(status_code=413, detail=str(e))
    row.size_bytes = size
    await db.commit()
    row = await _get_doc_row(doc_id, db)
    path = _doc_path(row)
    text = read_editable_content(path)
    content, truncated = _truncate(text, _PREVIEW_MAX_CHARS)
    return WikiRagDocumentContentOut(
        id=row.id,
        original_filename=row.original_filename,
        kind="text",
        editable=True,
        content=content,
        truncated=truncated,
    )


@router.patch("/{doc_id}", response_model=WikiRagDocumentOut)
async def update_document(
    doc_id: int,
    body: WikiRagDocumentUpdate,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(
        select(WikiRagDocument)
        .options(selectinload(WikiRagDocument.uploaded_by))
        .where(WikiRagDocument.id == doc_id)
    )
    row = r.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Документ не найден")
    note = body.comment
    if note is not None:
        note = note.strip() or None
        if note and len(note) > 4000:
            note = note[:4000]
        row.comment = note
    await db.commit()
    await db.refresh(row)
    return _doc_to_out(row)


@router.get("/{doc_id}/file")
async def download_document(
    doc_id: int,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_doc_row(doc_id, db)
    path = _doc_path(row)
    return FileResponse(
        path,
        media_type=row.mime_type or "application/octet-stream",
        filename=row.original_filename,
    )


@router.delete("/{doc_id}", status_code=204)
async def delete_document(
    doc_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_doc_row(doc_id, db)
    path = _doc_path(row)
    await db.delete(row)
    await db.commit()
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
