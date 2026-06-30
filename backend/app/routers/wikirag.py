import re
import secrets
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
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
    WikiRagDocumentContentOut,
    WikiRagDocumentContentUpdate,
    WikiRagDocumentOut,
    WikiRagDocumentUpdate,
    WikiRagLmStudioStatus,
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
    coerce_parsed,
    is_small_talk,
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
async def lm_studio_status(_: User = Depends(get_current_user)):
    data = await lm_studio_health()
    return WikiRagLmStudioStatus(
        ok=bool(data.get("ok")),
        models=list(data.get("models") or []),
        detail=data.get("detail"),
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


def _build_documents_context(rows: list[WikiRagDocument]) -> tuple[str, list[dict[str, str | int]]]:
    max_ctx = int(getattr(settings, "wiki_rag_chat_context_max_chars", None) or 4_000)
    blocks: list[str] = []
    meta: list[dict[str, str | int]] = []
    used = 0
    for row in rows:
        path = _doc_path(row)
        if not path.is_file():
            continue
        kind, text, _ = extract_plaintext(path, row.original_filename)
        if kind == "image":
            snippet = f"[изображение, текст не извлекается]"
        else:
            snippet = excerpt_for_context(text, 1200)
        block = f"### id={row.id} file={row.original_filename}\n{snippet}"
        if used + len(block) > max_ctx:
            break
        blocks.append(block)
        meta.append({"id": row.id, "filename": row.original_filename, "chars": len(snippet)})
        used += len(block)
    return "\n\n".join(blocks), meta


async def _prepare_chat_messages(
    q: str,
    document_ids: list[int] | None,
    history: list[dict[str, str]],
    db: AsyncSession,
) -> tuple[list[dict[str, str]], str, list[dict[str, str | int]]]:
    r = await db.execute(select(WikiRagDocument).order_by(WikiRagDocument.id.desc()))
    rows = list(r.scalars().all())
    if document_ids:
        id_set = set(document_ids)
        rows = [row for row in rows if row.id in id_set]
    elif rows:
        rows = rows[:3]

    mode = "simple" if is_small_talk(q) else "rag"
    if mode == "simple":
        doc_block, doc_meta = "", []
    else:
        doc_block, doc_meta = _build_documents_context(rows)
    messages = build_messages(q, doc_block, history, mode=mode)
    return messages, mode, doc_meta


@router.post("/chat/preview", response_model=WikiRagChatPreviewOut)
async def wiki_rag_chat_preview(
    body: WikiRagChatRequest,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = body.message.strip()
    history = sanitize_chat_history([{"role": m.role, "content": m.content} for m in body.history])
    messages, mode, doc_meta = await _prepare_chat_messages(q, body.document_ids, history, db)
    stats = messages_stats(messages)
    return WikiRagChatPreviewOut(
        mode=mode,
        documents=doc_meta,
        messages=messages,
        total_chars=stats["total_chars"],
        hint=(
            "Режим «simple»: без документов (приветствие и короткие фразы)."
            if mode == "simple"
            else f"Режим «rag»: до {len(doc_meta)} документов в контексте."
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
    messages, mode, doc_meta = await _prepare_chat_messages(q, body.document_ids, history, db)
    stats = messages_stats(messages)
    meta = {
        "mode": mode,
        "total_chars": stats["total_chars"],
        "documents": doc_meta,
        "proxy_bypass": True,
    }
    try:
        raw, model = await lm_studio_chat(messages)
        parsed = coerce_parsed(raw)
        return WikiRagChatResponse(ok=True, raw=raw, parsed=parsed, model=model, meta=meta)
    except httpx.HTTPError as e:
        return WikiRagChatResponse(
            ok=False,
            error=f"Ошибка связи с LM Studio ({settings.lm_studio_base_url}): {e}",
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
