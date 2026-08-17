import re
import secrets
import shutil
import json
import time
from pathlib import Path
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_current_editor_or_superuser, get_current_user
from app.config import settings
from app.database import get_db
from app.models import User, WikiRagChunk, WikiRagDocument
from app.observability import get_logger
from app.schemas import (
    WikiRagChatPreviewOut,
    WikiRagChatRequest,
    WikiRagChatResponse,
    WikiRagCoraxImportOut,
    WikiRagDocumentContentOut,
    WikiRagDocumentContentUpdate,
    WikiRagDocumentOut,
    WikiRagDocumentUpdate,
    WikiRagFolderCreate,
    WikiRagFolderDelete,
    WikiRagFolderOut,
    WikiRagFolderRename,
    WikiRagFoldersListOut,
    WikiRagIndexImportOut,
    WikiRagIndexSettingsOut,
    WikiRagIndexSettingsUpdate,
    WikiRagIndexStatusOut,
    WikiRagLmStudioStatus,
    WikiRagReindexOut,
)
from app.wikirag_corax import (
    CORAX_BUNDLE_FILENAMES,
    CORAX_COMPUTERS_MD,
    CORAX_FILE_PREFIX,
    CORAX_FOLDER,
    CORAX_HARDWARE_MD,
    CORAX_INDEX_FILENAME,
    CORAX_LEGACY_FILENAMES,
    CORAX_NETWORK_MD,
    CORAX_README_FILENAME,
    CORAX_SOFTWARE_MD,
    CORAX_SOFTWARE_STATS_MD,
    CORAX_TICKETS_MD,
    CORAX_USERS_MD,
    CoraxLevel,
    build_corax_context_excerpt,
    build_corax_knowledge_bundle,
    corax_file_comment,
    pick_corax_level,
)
from app.wikirag_context_budget import (
    chars_for_tokens,
    estimate_messages_tokens,
    prompt_token_budget,
    shrink_messages,
)
from app.wikirag_content import (
    _PREVIEW_MAX_CHARS,
    _truncate,
    context_keywords,
    excerpt_for_context,
    extract_plaintext,
    image_data_url,
    is_editable_filename,
    read_editable_content,
    write_editable_content,
)
from app.wikirag_index import (
    INDEX_ERROR,
    INDEX_PENDING,
    INDEX_READY,
    build_context_from_chunks,
    retrieve_relevant_chunks,
)
from app.wikirag_index_queue import wikirag_index_queue
from app.wikirag_options import get_auto_index, get_embed_model, set_auto_index, set_embed_model
from app.wikirag_tools import run_wikirag_tools
from app.wikirag_lm import (
    build_messages,
    classify_wikirag_question,
    coerce_parsed,
    detect_llm_provider,
    ensure_model_num_ctx,
    is_small_talk,
    llm_provider_label,
    normalize_lm_base_url,
    sanitize_chat_history,
    lm_studio_chat,
    lm_studio_chat_stream,
    lm_studio_health,
    messages_stats,
)

router = APIRouter(prefix="/wiki-rag", tags=["wiki-rag"])
_LOG = get_logger("corax.wikirag")

_BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
_MAX_BYTES = 100 * 1024 * 1024
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


def _safe_path_part(part: str) -> str:
    cleaned = re.sub(r"[^\w.\- +()\[\]]+", "_", part.strip(), flags=re.UNICODE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip("._ ")
    return cleaned[:120]


def _normalize_relative_path(rel: str | None, fallback_filename: str) -> str:
    """Sanitize browser webkitRelativePath / filename into a safe relative POSIX path."""
    raw = (rel or fallback_filename or "").replace("\\", "/").strip().lstrip("/")
    parts: list[str] = []
    for piece in raw.split("/"):
        piece = piece.strip()
        if not piece or piece in (".", ".."):
            continue
        safe = _safe_path_part(piece)
        if safe and safe not in (".", ".."):
            parts.append(safe)
    if not parts:
        ext = Path(fallback_filename).suffix.lower()
        parts = [f"{_safe_stem(fallback_filename)}{ext}"]
    # keep leaf extension from original when possible
    leaf = parts[-1]
    want_ext = Path(fallback_filename).suffix.lower()
    if want_ext and Path(leaf).suffix.lower() != want_ext:
        parts[-1] = f"{_safe_stem(leaf)}{want_ext}"
    joined = "/".join(parts)
    return joined[:480] or f"{_safe_stem(fallback_filename)}{Path(fallback_filename).suffix.lower()}"


def _allocate_stored_path(display_rel: str) -> tuple[str, Path]:
    """
    Place file under WIKI_RAG_DIR preserving folder tree.
    Disk name: <dirs>/{token}_{stem}{ext}; DB stores relative path from storage root.
    """
    root = _storage_dir()
    rel = Path(display_rel)
    parent = rel.parent
    ext = rel.suffix.lower()
    stem = _safe_stem(rel.name)
    stored_leaf = f"{secrets.token_hex(8)}_{stem}{ext}"
    if str(parent) in (".", ""):
        rel_stored = stored_leaf
        dest = root / stored_leaf
    else:
        rel_stored = str(parent / stored_leaf).replace("\\", "/")
        dest = root / parent / stored_leaf
    resolved_root = root.resolve()
    resolved_dest = dest.resolve()
    if not resolved_dest.is_relative_to(resolved_root):
        raise HTTPException(status_code=400, detail="Некорректный путь файла.")
    dest.parent.mkdir(parents=True, exist_ok=True)
    return rel_stored, dest


_FOLDER_KEEP = ".corax_folder"


def _normalize_folder_path(raw: str) -> str:
    cleaned = (raw or "").replace("\\", "/").strip().strip("/")
    parts: list[str] = []
    for piece in cleaned.split("/"):
        piece = piece.strip()
        if not piece or piece in (".", ".."):
            continue
        safe = _safe_path_part(piece)
        if safe and safe not in (".", "..") and not safe.startswith("."):
            parts.append(safe)
    if not parts:
        raise HTTPException(status_code=400, detail="Укажите имя папки.")
    joined = "/".join(parts)
    if len(joined) > 400:
        raise HTTPException(status_code=400, detail="Слишком длинный путь папки.")
    return joined


def _folder_path_for_ops(raw: str) -> str:
    """Keep existing folder names intact (no re-sanitize) so delete/rename match disk+DB."""
    cleaned = (raw or "").replace("\\", "/").strip().strip("/")
    if not cleaned:
        raise HTTPException(status_code=400, detail="Укажите имя папки.")
    parts: list[str] = []
    for piece in cleaned.split("/"):
        piece = piece.strip()
        if not piece or piece in (".", ".."):
            continue
        if piece.startswith(".") or "/" in piece or "\\" in piece:
            raise HTTPException(status_code=400, detail="Некорректный путь папки.")
        parts.append(piece[:180])
    if not parts:
        raise HTTPException(status_code=400, detail="Укажите имя папки.")
    joined = "/".join(parts)
    if len(joined) > 400:
        raise HTTPException(status_code=400, detail="Слишком длинный путь папки.")
    return joined


def _path_under_folder(path: str, folder: str) -> bool:
    n = (path or "").replace("\\", "/")
    return n == folder or n.startswith(folder + "/")


def _collect_folder_paths(db_filenames: list[str]) -> list[str]:
    folders: set[str] = set()
    root = _storage_dir()
    try:
        for p in root.rglob("*"):
            if not p.is_dir():
                continue
            rel = str(p.relative_to(root)).replace("\\", "/")
            if not rel or rel.startswith(".") or "/." in f"/{rel}/":
                continue
            folders.add(rel)
    except OSError:
        pass
    for name in db_filenames:
        parts = Path(str(name).replace("\\", "/")).parts
        for i in range(1, len(parts)):
            folders.add("/".join(parts[:i]))
    return sorted(folders)


def _rewrite_path_prefix(path: str, old: str, new: str) -> str:
    p = (path or "").replace("\\", "/")
    if p == old:
        return new
    prefix = old + "/"
    if p.startswith(prefix):
        return new + p[len(old) :]
    return p


def _assert_under_storage(path: Path) -> Path:
    root = _storage_dir().resolve()
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise HTTPException(status_code=400, detail="Некорректный путь.")
    return resolved


def _stored_rel(row: WikiRagDocument) -> str:
    return str(row.stored_filename or "").replace("\\", "/").strip("/")


def _doc_path(row: WikiRagDocument) -> Path:
    rel = _stored_rel(row)
    return _storage_dir() / rel if rel else _storage_dir()


def _unlink_doc_file(row: WikiRagDocument) -> None:
    rel = _stored_rel(row)
    if not rel:
        return
    path = _storage_dir() / rel
    try:
        root = _storage_dir().resolve()
        resolved = path.resolve()
        if resolved == root or not resolved.is_relative_to(root):
            return
        resolved.unlink(missing_ok=True)
    except OSError:
        pass


async def _delete_document_row(row: WikiRagDocument, db: AsyncSession) -> None:
    await db.execute(sa_delete(WikiRagChunk).where(WikiRagChunk.document_id == row.id))
    await db.delete(row)


def _remove_dir_tree(dest: Path) -> None:
    if not dest.exists():
        return
    try:
        shutil.rmtree(dest)
    except OSError as e:
        raise HTTPException(status_code=409, detail=f"Не удалось удалить папку: {e}") from e


async def _delete_folder_impl(
    path: str,
    *,
    recursive: bool,
    db: AsyncSession,
) -> WikiRagFolderOut:
    folder = _folder_path_for_ops(path)
    # Also try sanitized form if UI/DB used create-folder sanitization.
    candidates = [folder]
    try:
        folder_alt = _normalize_folder_path(path)
        if folder_alt not in candidates:
            candidates.append(folder_alt)
    except HTTPException:
        pass

    r = await db.execute(select(WikiRagDocument))
    rows = list(r.scalars().all())
    inside: list[WikiRagDocument] = []
    seen: set[int] = set()
    matched_folder = folder
    for cand in candidates:
        batch = [
            row
            for row in rows
            if row.id not in seen
            and (
                _path_under_folder(str(row.original_filename or ""), cand)
                or _path_under_folder(str(row.stored_filename or ""), cand)
            )
        ]
        if batch:
            matched_folder = cand
            for row in batch:
                seen.add(row.id)
                inside.append(row)

    if inside and not recursive:
        raise HTTPException(
            status_code=409,
            detail=f"Папка не пуста ({len(inside)} док.). Удалите с recursive=true или очистите содержимое.",
        )

    deleted = 0
    disk_paths: list[Path] = []
    if inside:
        ids = [row.id for row in inside]
        for row in inside:
            disk_paths.append(_doc_path(row))
        await db.execute(sa_delete(WikiRagChunk).where(WikiRagChunk.document_id.in_(ids)))
        await db.execute(sa_delete(WikiRagDocument).where(WikiRagDocument.id.in_(ids)))
        deleted = len(ids)
        await db.flush()
        root = _storage_dir().resolve()
        for p in disk_paths:
            try:
                resolved = p.resolve()
                if resolved.is_relative_to(root) and resolved.is_file():
                    resolved.unlink(missing_ok=True)
            except OSError:
                pass

    root = _storage_dir()
    for cand in candidates:
        dest = root / cand
        try:
            resolved = _assert_under_storage(dest)
        except HTTPException:
            continue
        if resolved.exists() and resolved.is_dir():
            if recursive or deleted > 0 or not _dir_has_foreign_files(resolved):
                _remove_dir_tree(resolved)
            else:
                raise HTTPException(
                    status_code=409,
                    detail="Папка содержит файлы на диске. Удалите с recursive=true.",
                )
        elif resolved.exists() and resolved.is_file():
            try:
                resolved.unlink()
            except OSError as e:
                raise HTTPException(status_code=409, detail=f"Не удалось удалить: {e}") from e

    await db.commit()
    _LOG.info(
        "wikirag_folder_deleted",
        extra={"path": matched_folder, "deleted_documents": deleted, "recursive": recursive},
    )
    return WikiRagFolderOut(path=matched_folder, ok=True, deleted_documents=deleted)


def _assert_doc_file(row_path: Path) -> None:
    root = _storage_dir().resolve()
    resolved = row_path.resolve()
    if resolved == root or not resolved.is_relative_to(root):
        raise HTTPException(status_code=400, detail="Некорректный путь файла.")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="Файл на диске не найден")


async def _get_doc_row(doc_id: int, db: AsyncSession, *, require_file: bool = True) -> WikiRagDocument:
    row = await db.get(WikiRagDocument, doc_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Документ не найден")
    if require_file:
        _assert_doc_file(_doc_path(row))
    return row


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
        indexed_at=getattr(row, "indexed_at", None),
        index_status=(getattr(row, "index_status", None) or INDEX_PENDING),
        index_error=getattr(row, "index_error", None),
        chunk_count=int(getattr(row, "chunk_count", None) or 0),
    )


def _queue_index_if_enabled(doc_id: int) -> bool:
    """Queue single-doc index only when auto_index setting is on."""
    if not get_auto_index():
        return False
    wikirag_index_queue.enqueue(doc_id)
    return True


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

    # Папка в библиотеке WikiRAG (дерево файлов + .corax_folder)
    folder_dir = _storage_dir() / CORAX_FOLDER
    folder_dir.mkdir(parents=True, exist_ok=True)
    keep = folder_dir / _FOLDER_KEEP
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
            ext = Path(filename).suffix or ".txt"
            stored = f"{secrets.token_hex(8)}_{_safe_stem(filename)}{ext}"
            dest = _storage_dir() / stored
            dest.write_bytes(raw)
            row = WikiRagDocument(
                original_filename=filename,
                stored_filename=stored,
                mime_type=mime,
                size_bytes=len(raw),
                comment=corax_file_comment(filename),
                uploaded_by_id=current.id,
                index_status=INDEX_PENDING,
            )
            db.add(row)
            created_count += 1
        else:
            dest = _storage_dir() / row.stored_filename
            dest.write_bytes(raw)
            row.size_bytes = len(raw)
            row.comment = corax_file_comment(filename)
            row.mime_type = mime
            row.index_status = INDEX_PENDING
            row.index_error = None
        saved_docs.append(row)

    # Удалить устаревшие CSV / плоские MD прошлых версий
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
    for row in saved_docs:
        await db.refresh(row, attribute_names=["uploaded_by"])
        row.uploaded_by = current
        # CORAX import never auto-queues: leave pending until «Reindex» / «Reindex all».
        # Auto-index applies only to regular file uploads.

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
    fn = filename.replace("\\", "/").lower()
    base = Path(fn).name
    if "corax-inventory" in fn or base.startswith("corax_") or base == "00_system_index.md":
        if base.endswith(".md"):
            return "справочник CORAX (Markdown); секции связаны по computer_id и hostname"
        if base.endswith(".csv"):
            return "таблица CORAX; строки связаны по computer_id и hostname"
        return "справочник CORAX (схема данных)"
    return "документ"


def _doc_excerpt_limit(
    filename: str,
    *,
    max_chars: int | None = None,
    question_focus: str = "general",
) -> int:
    fn = Path((filename or "").replace("\\", "/")).name.lower()
    cap = max_chars or 10_000
    if fn in (Path(CORAX_COMPUTERS_MD).name.lower(), Path(CORAX_HARDWARE_MD).name.lower()) and question_focus == "os_hardware":
        return min(6000, cap)
    if fn.startswith("corax_") and fn.endswith(".md"):
        return min(2200, cap)
    if fn == "00_system_index.md":
        return min(1800, cap)
    if fn == "corax_компьютеры.csv" and question_focus == "os_hardware":
        return min(5000, cap)
    if fn.startswith("corax_") and fn.endswith(".csv"):
        return min(1200, cap)
    if fn.startswith("corax_"):
        return min(800, cap)
    return min(900, cap)


def _build_documents_context_keyword(
    rows: list[WikiRagDocument],
    *,
    max_chars: int | None = None,
    question_focus: str = "general",
    question: str = "",
) -> tuple[str, list[dict[str, str | int]]]:
    max_ctx = max_chars
    if max_ctx is None:
        max_ctx = int(getattr(settings, "wiki_rag_chat_context_max_chars", None) or 16_000)
    keywords = context_keywords(question)

    def rank(row: WikiRagDocument) -> tuple[int, int]:
        filename = (row.original_filename or "").lower()
        comment = (row.comment or "").lower()
        matches = sum(1 for word in keywords if word in filename or word in comment)
        return (-matches, -(row.id or 0))

    ordered = sorted(rows, key=rank)
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
                query=question,
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


async def _build_documents_context(
    db: AsyncSession,
    rows: list[WikiRagDocument],
    *,
    max_chars: int | None = None,
    question_focus: str = "general",
    question: str = "",
) -> tuple[str, list[dict[str, str | int]]]:
    max_ctx = max_chars
    if max_ctx is None:
        max_ctx = int(getattr(settings, "wiki_rag_chat_context_max_chars", None) or 16_000)

    try:
        ranked = await retrieve_relevant_chunks(db, question, rows)
    except Exception:
        ranked = None
    if ranked:
        return build_context_from_chunks(
            ranked,
            max_chars=max_ctx,
            doc_hint_fn=_doc_context_hint,
        )
    return _build_documents_context_keyword(
        rows, max_chars=max_ctx, question_focus=question_focus, question=question
    )


_CORAX_DOC_PRIORITY = (
    CORAX_SOFTWARE_STATS_MD,
    CORAX_SOFTWARE_MD,
    CORAX_USERS_MD,
    CORAX_TICKETS_MD,
    CORAX_COMPUTERS_MD,
    CORAX_HARDWARE_MD,
    CORAX_NETWORK_MD,
    f"{CORAX_FOLDER}/CORAX_теги.md",
    CORAX_INDEX_FILENAME,
)

_HARDWARE_DOC_PRIORITY = (
    CORAX_HARDWARE_MD,
    CORAX_COMPUTERS_MD,
    CORAX_NETWORK_MD,
    f"{CORAX_FOLDER}/CORAX_теги.md",
    CORAX_INDEX_FILENAME,
    CORAX_SOFTWARE_STATS_MD,
    CORAX_SOFTWARE_MD,
    CORAX_TICKETS_MD,
)


def _doc_priority_for_question(question: str) -> tuple[str, ...]:
    from app.wikirag_lm import classify_wikirag_question

    if classify_wikirag_question(question) == "os_hardware":
        return _HARDWARE_DOC_PRIORITY
    return _CORAX_DOC_PRIORITY


def _is_corax_doc_name(name: str | None) -> bool:
    n = (name or "").replace("\\", "/")
    base = Path(n).name
    return (
        n.startswith(f"{CORAX_FOLDER}/")
        or base.startswith(CORAX_FILE_PREFIX)
        or base == "00_system_index.md"
    )


def _has_corax_import_docs(rows: list[WikiRagDocument]) -> bool:
    return any(_is_corax_doc_name(r.original_filename) for r in rows)


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
    response_mode: str = "fast",
) -> tuple[list[dict[str, str]], str, list[dict[str, str | int]], dict[str, Any], str, list[dict[str, Any]]]:
    """Classic RAG path (Desktop/RAG/script.py): retrieve top-k MD chunks → strict prompt.

    Legacy tools summaries are optional and never replace retrieved context.
    """
    r = await db.execute(select(WikiRagDocument).order_by(WikiRagDocument.id.desc()))
    rows = list(r.scalars().all())
    if document_ids:
        id_set = set(document_ids)
        rows = [row for row in rows if row.id in id_set]
    elif rows:
        # Keep a wide window — classic RAG needs the CORAX MD corpus in the search set.
        rows = rows[:80]

    mode = "simple" if is_small_talk(q) else "rag"
    question_focus = classify_wikirag_question(q)
    corax_stats: dict[str, Any] = {"focus": question_focus, "path": "classic"}
    rag_sources: list[dict[str, Any]] = []
    doc_meta: list[dict[str, str | int]] = []

    if mode == "simple":
        messages = build_messages(q, "", history, mode=mode, response_mode=response_mode)
        return messages, mode, [], corax_stats, "", rag_sources

    docs_for_retrieve = list(rows)
    if not include_corax:
        docs_for_retrieve = [
            row for row in docs_for_retrieve if not _is_corax_doc_name(row.original_filename)
        ]
    else:
        docs_for_retrieve = _prioritize_corax_docs(docs_for_retrieve, question=q)

    # 1) Primary: vector + lexical retrieve (k=15 by default) — like Chroma retriever.
    ranked = await retrieve_relevant_chunks(db, q, docs_for_retrieve) if docs_for_retrieve else []
    context_cap = int(getattr(settings, "wiki_rag_classic_context_chars", None) or 24_000)
    doc_block, doc_meta = build_context_from_chunks(
        ranked,
        max_chars=context_cap,
        doc_hint_fn=_doc_context_hint,
    )
    for ch in ranked:
        fname = (ch.filename or "").replace("\\", "/")
        base = Path(fname).name or fname or "источник"
        rag_sources.append(
            {
                "kind": "wiki_chunk",
                "document_id": ch.document_id,
                "filename": fname,
                "label": base,
                "excerpt": (ch.content or "")[:280],
                "score": ch.score,
                "source_table": ch.source_table,
                "hostname": ch.hostname,
            }
        )
    corax_stats.update(
        {
            "retrieved_chunks": len(ranked),
            "context_chars": len(doc_block or ""),
            "documents": len(docs_for_retrieve),
        }
    )

    # 2) Optional tools: only as a thin supplement when classic retrieve is empty/thin.
    use_tools = bool(getattr(settings, "wiki_rag_use_tools", False))
    tool_block = ""
    if use_tools and len(doc_block or "") < 400:
        pack = await run_wikirag_tools(
            db,
            q,
            wiki_documents=docs_for_retrieve,
            include_corax=include_corax,
        )
        tool_block = pack.context or ""
        if pack.sources_for_api():
            rag_sources.extend(pack.sources_for_api())
        corax_stats["tools"] = pack.tools_used
        corax_stats["path"] = "classic+tools_fallback"

    messages = build_messages(
        q,
        doc_block or "",
        history,
        corax_block=tool_block,
        mode=mode,
        data_char_budget=context_cap,
        question_focus=question_focus,
        response_mode=response_mode,
    )
    # Fit into token budget without deleting retrieved context first.
    if estimate_messages_tokens(messages) > prompt_token_budget():
        messages = shrink_messages(messages, prompt_token_budget())
        corax_stats["shrunk"] = True

    return messages, mode, doc_meta, corax_stats, "", rag_sources


def _resolve_lm_base_url(raw: str | None) -> str | None:
    if raw is None or not str(raw).strip():
        return None
    try:
        base = normalize_lm_base_url(raw)
        # Настройка хранится в браузере, но запрос выполняет контейнер. Поэтому
        # localhost клиента нельзя использовать как localhost Docker-контейнера.
        if settings.corax_docker and re.match(r"^https?://(127\.0\.0\.1|localhost):11434/v1$", base):
            return "http://host.docker.internal:11434/v1"
        return base
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _attach_rag_sources(parsed: dict[str, Any], rag_sources: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge tool/retrieval sources into parsed.sources for UI transparency."""
    if not rag_sources:
        return parsed
    existing = list(parsed.get("sources") or [])
    by_key: set[str] = set()
    out: list[dict[str, Any]] = []
    for s in existing + rag_sources:
        if not isinstance(s, dict):
            continue
        key = f"{s.get('kind')}:{s.get('document_id')}:{s.get('chunk_index')}:{s.get('hostname')}:{s.get('label')}"
        if key in by_key:
            continue
        by_key.add(key)
        item: dict[str, Any] = {
            "document_id": int(s["document_id"]) if s.get("document_id") is not None else 0,
            "filename": str(s.get("filename") or s.get("label") or "источник"),
            "excerpt": str(s.get("excerpt") or "")[:280],
        }
        for opt in ("kind", "label", "chunk_index", "hostname", "computer_id", "source_table", "score"):
            if s.get(opt) is not None:
                item[opt] = s[opt]
        out.append(item)
    parsed["sources"] = out[:24]
    return parsed


@router.post("/chat/preview", response_model=WikiRagChatPreviewOut)
async def wiki_rag_chat_preview(
    body: WikiRagChatRequest,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = body.message.strip()
    lm_base = _resolve_lm_base_url(body.lm_base_url)
    await ensure_model_num_ctx(base_url=lm_base, model=body.lm_model)
    history = sanitize_chat_history([{"role": m.role, "content": m.content} for m in body.history])
    messages, mode, doc_meta, corax_stats, _corax_fallback, rag_sources = await _prepare_chat_messages(
        q, body.document_ids, history, db, include_corax=body.include_corax, response_mode=body.response_mode
    )
    stats = messages_stats(messages)
    tools = corax_stats.get("tools") or []
    return WikiRagChatPreviewOut(
        mode=mode,
        documents=doc_meta,
        messages=messages,
        total_chars=stats["total_chars"],
        hint=(
            "Режим «simple»: без документов (приветствие и короткие фразы)."
            if mode == "simple"
            else (
                f"Режим «rag»: CORAX {corax_stats.get('computers', 0)} ПК, "
                f"источников {len(rag_sources)}, инструменты: {', '.join(tools) or '—'}."
            )
        ),
    )


@router.post("/chat", response_model=WikiRagChatResponse)
async def wiki_rag_chat(
    body: WikiRagChatRequest,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = body.message.strip()
    lm_base = _resolve_lm_base_url(body.lm_base_url)
    num_ctx = await ensure_model_num_ctx(base_url=lm_base, model=body.lm_model)
    history = sanitize_chat_history([{"role": m.role, "content": m.content} for m in body.history])
    started = time.perf_counter()
    messages, mode, doc_meta, corax_stats, _corax_fallback, rag_sources = await _prepare_chat_messages(
        q, body.document_ids, history, db, include_corax=body.include_corax, response_mode=body.response_mode
    )
    context_ms = round((time.perf_counter() - started) * 1000)
    stats = messages_stats(messages)
    meta = {
        "mode": mode,
        "total_chars": stats["total_chars"],
        "documents": doc_meta,
        "corax": corax_stats,
        "sources": rag_sources,
        "lm_base_url": lm_base or settings.lm_studio_base_url,
        "num_ctx": num_ctx,
        "proxy_bypass": True,
        "timings_ms": {"context": context_ms},
    }
    try:
        raw, model = await lm_studio_chat(
            messages,
            base_url=lm_base,
            model=body.lm_model,
            mode=mode if mode in ("simple", "rag") else "rag",
            response_mode=body.response_mode,
        )
        meta["timings_ms"]["total"] = round((time.perf_counter() - started) * 1000)
        parsed = _attach_rag_sources(coerce_parsed(raw), rag_sources)
        return WikiRagChatResponse(ok=True, raw=raw, parsed=parsed, model=model, meta=meta)
    except httpx.HTTPError as e:
        shown_url = lm_base or settings.lm_studio_base_url
        label = llm_provider_label(detect_llm_provider(shown_url))
        return WikiRagChatResponse(
            ok=False,
            error=f"Нет связи с {label} ({shown_url}): {e}",
            meta=meta,
        )
    except RuntimeError as e:
        return WikiRagChatResponse(ok=False, error=str(e), meta=meta)
    except Exception as e:
        return WikiRagChatResponse(ok=False, error=str(e), meta=meta)


@router.post("/chat/stream")
async def wiki_rag_chat_stream(
    body: WikiRagChatRequest,
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """SSE-версия чата: meta → delta* → done или error."""
    started = time.perf_counter()
    q = body.message.strip()
    lm_base = _resolve_lm_base_url(body.lm_base_url)
    num_ctx = await ensure_model_num_ctx(base_url=lm_base, model=body.lm_model)
    history = sanitize_chat_history([{"role": m.role, "content": m.content} for m in body.history])
    messages, mode, doc_meta, corax_stats, _corax_fallback, rag_sources = await _prepare_chat_messages(
        q, body.document_ids, history, db, include_corax=body.include_corax, response_mode=body.response_mode
    )
    context_ms = round((time.perf_counter() - started) * 1000)
    stats = messages_stats(messages)
    meta: dict[str, Any] = {
        "mode": mode,
        "total_chars": stats["total_chars"],
        "documents": doc_meta,
        "corax": corax_stats,
        "sources": rag_sources,
        "lm_base_url": lm_base or settings.lm_studio_base_url,
        "num_ctx": num_ctx,
        "proxy_bypass": True,
        "timings_ms": {"context": context_ms},
    }

    async def event_stream() -> AsyncIterator[str]:
        raw_parts: list[str] = []
        first_token_at: float | None = None
        model: str | None = None
        yield _sse("meta", meta)
        try:
            async for delta, used_model in lm_studio_chat_stream(
                messages,
                base_url=lm_base,
                model=body.lm_model,
                mode=mode if mode in ("simple", "rag") else "rag",
                response_mode=body.response_mode,
            ):
                if first_token_at is None:
                    first_token_at = time.perf_counter()
                raw_parts.append(delta)
                model = used_model or model
                yield _sse("delta", {"text": delta})

            raw = "".join(raw_parts)
            parsed = _attach_rag_sources(coerce_parsed(raw), rag_sources)
            meta["timings_ms"]["first_token"] = (
                round((first_token_at - started) * 1000) if first_token_at is not None else None
            )
            meta["timings_ms"]["total"] = round((time.perf_counter() - started) * 1000)
            _LOG.info("WikiRAG stream completed", extra={"timings_ms": meta["timings_ms"], "mode": mode})
            yield _sse("done", {"raw": raw, "parsed": parsed, "model": model, "meta": meta})
        except Exception as e:
            meta["timings_ms"]["total"] = round((time.perf_counter() - started) * 1000)
            yield _sse("error", {"error": str(e), "meta": meta})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/reindex-all", response_model=WikiRagReindexOut)
async def reindex_all_documents(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(WikiRagDocument.id))
    ids = list(r.scalars().all())
    for doc_id in ids:
        row = await db.get(WikiRagDocument, doc_id)
        if row is not None:
            row.index_status = INDEX_PENDING
            row.index_error = None
    await db.commit()
    wikirag_index_queue.enqueue(*[int(x) for x in ids])
    return WikiRagReindexOut(
        ok=True,
        total=len(ids),
        indexed=0,
        failed=0,
        index_status=INDEX_PENDING,
        detail="Переиндексация запущена в фоне",
    )


@router.post("/reindex-pending", response_model=WikiRagReindexOut)
async def reindex_pending_documents(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    """Index only pending/error docs — skip already ready (faster after CORAX import)."""
    r = await db.execute(
        select(WikiRagDocument).order_by(WikiRagDocument.id.asc())
    )
    ids: list[int] = []
    for row in r.scalars().all():
        st = (getattr(row, "index_status", None) or INDEX_PENDING).strip().lower()
        if st == INDEX_READY:
            continue
        row.index_status = INDEX_PENDING
        row.index_error = None
        ids.append(int(row.id))
    await db.commit()
    if ids:
        wikirag_index_queue.enqueue(*ids)
    return WikiRagReindexOut(
        ok=True,
        total=len(ids),
        indexed=0,
        failed=0,
        index_status=INDEX_PENDING if ids else INDEX_READY,
        detail=(
            f"Индексация {len(ids)} ожидающих файлов запущена в фоне"
            if ids
            else "Нет файлов в статусе ожидания"
        ),
    )


@router.get("/folders", response_model=WikiRagFoldersListOut)
async def list_folders(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(WikiRagDocument.original_filename))
    names = [str(x) for x in r.scalars().all() if x]
    return WikiRagFoldersListOut(folders=_collect_folder_paths(names))


@router.post("/folders", response_model=WikiRagFolderOut)
async def create_folder(
    body: WikiRagFolderCreate,
    _: User = Depends(get_current_editor_or_superuser),
):
    path = _normalize_folder_path(body.path)
    root = _storage_dir()
    dest = root / path
    _assert_under_storage(dest)
    dest.mkdir(parents=True, exist_ok=True)
    keep = dest / _FOLDER_KEEP
    if not keep.exists():
        keep.write_text("", encoding="utf-8")
    return WikiRagFolderOut(path=path, ok=True)


@router.patch("/folders", response_model=WikiRagFolderOut)
async def rename_folder(
    body: WikiRagFolderRename,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    src = _normalize_folder_path(body.from_path)
    dst = _normalize_folder_path(body.to_path)
    if src == dst:
        return WikiRagFolderOut(path=dst, ok=True)
    if dst == src or dst.startswith(src + "/"):
        raise HTTPException(status_code=400, detail="Нельзя переместить папку внутрь самой себя.")
    if src.startswith(dst + "/"):
        # allowing rename of parent leaf is fine; blocking only nested-into-self above
        pass

    root = _storage_dir()
    src_dir = root / src
    dst_dir = root / dst
    _assert_under_storage(src_dir)
    _assert_under_storage(dst_dir)

    if dst_dir.exists():
        raise HTTPException(status_code=409, detail="Папка с таким именем уже существует.")

    r = await db.execute(select(WikiRagDocument))
    rows = list(r.scalars().all())
    touched = 0
    for row in rows:
        orig = str(row.original_filename or "").replace("\\", "/")
        stored = str(row.stored_filename or "").replace("\\", "/")
        new_orig = _rewrite_path_prefix(orig, src, dst)
        new_stored = _rewrite_path_prefix(stored, src, dst)
        if new_orig != orig or new_stored != stored:
            row.original_filename = new_orig[:512]
            row.stored_filename = new_stored[:512]
            touched += 1

    if src_dir.is_dir():
        dst_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(src_dir), str(dst_dir))
        except OSError as e:
            await db.rollback()
            raise HTTPException(status_code=409, detail=f"Не удалось переместить папку на диске: {e}") from e
    else:
        # logical-only folder (prefix from docs) — ensure destination keep marker if needed
        if touched:
            dst_dir.mkdir(parents=True, exist_ok=True)
            keep = dst_dir / _FOLDER_KEEP
            if not keep.exists():
                keep.write_text("", encoding="utf-8")

    await db.commit()
    return WikiRagFolderOut(path=dst, ok=True)


@router.post("/folders/delete", response_model=WikiRagFolderOut)
async def delete_folder_post(
    body: WikiRagFolderDelete,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    return await _delete_folder_impl(body.path, recursive=bool(body.recursive), db=db)


@router.delete("/folders", response_model=WikiRagFolderOut)
async def delete_folder(
    path: str = Query(..., min_length=1, max_length=400),
    recursive: bool = Query(default=True),
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    return await _delete_folder_impl(path, recursive=recursive, db=db)


def _dir_has_foreign_files(dest: Path) -> bool:
    """True if directory contains real files other than folder keep-markers."""
    try:
        for child in dest.rglob("*"):
            if not child.is_file():
                continue
            if child.name == _FOLDER_KEEP:
                continue
            return True
    except OSError:
        return True
    return False


@router.get("/export-index")
async def export_index(
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    from app.wikirag_pack import build_index_zip

    data = await build_index_zip(db, _storage_dir())
    stamp = time.strftime("%Y%m%d_%H%M%S")
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="corax-wikirag-index_{stamp}.zip"'},
    )


@router.get("/index-settings", response_model=WikiRagIndexSettingsOut)
async def get_index_settings(_: User = Depends(get_current_user)):
    return WikiRagIndexSettingsOut(auto_index=get_auto_index(), embed_model=get_embed_model())


@router.get("/index-status", response_model=WikiRagIndexStatusOut)
async def get_index_status(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Lightweight counts for the background watcher — not the full document list."""
    from sqlalchemy import func

    counts = {"pending": 0, "ready": 0, "error": 0}
    r = await db.execute(
        select(WikiRagDocument.index_status, func.count()).group_by(WikiRagDocument.index_status)
    )
    total = 0
    for status, n in r.all():
        key = (status or INDEX_PENDING).strip().lower() or INDEX_PENDING
        total += int(n or 0)
        if key in counts:
            counts[key] = int(n or 0)
        else:
            counts["pending"] += int(n or 0)

    pending_r = await db.execute(
        select(WikiRagDocument.id)
        .where(func.lower(func.coalesce(WikiRagDocument.index_status, INDEX_PENDING)).notin_((INDEX_READY, INDEX_ERROR)))
        .order_by(WikiRagDocument.id.asc())
        .limit(5000)
    )
    pending_ids = [int(x) for x in pending_r.scalars().all()]
    return WikiRagIndexStatusOut(
        pending=counts["pending"],
        ready=counts["ready"],
        error=counts["error"],
        total=total,
        queue_size=wikirag_index_queue.queue_size,
        active_id=wikirag_index_queue.active_id,
        indexing=wikirag_index_queue.indexing,
        pending_ids=pending_ids,
    )


@router.patch("/index-settings", response_model=WikiRagIndexSettingsOut)
async def patch_index_settings(
    body: WikiRagIndexSettingsUpdate,
    _: User = Depends(get_current_editor_or_superuser),
):
    if body.auto_index is not None:
        set_auto_index(bool(body.auto_index))
    if body.embed_model is not None:
        set_embed_model(body.embed_model)
    return WikiRagIndexSettingsOut(auto_index=get_auto_index(), embed_model=get_embed_model())


@router.post("/import-index", response_model=WikiRagIndexImportOut)
async def import_index(
    file: UploadFile = File(...),
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    from app.wikirag_pack import import_index_zip

    result = await import_index_zip(db, _storage_dir(), file, current)
    return WikiRagIndexImportOut(**result)


@router.post("", response_model=WikiRagDocumentOut)
async def upload_document(
    file: UploadFile = File(...),
    comment: str | None = Form(default=None),
    relative_path: str | None = Form(default=None),
    current: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    fn = (file.filename or "").strip()
    if not fn:
        raise HTTPException(status_code=400, detail="Файл не выбран.")
    # Prefer relative folder path from browser; basename alone for single-file uploads.
    display_name = _normalize_relative_path(relative_path, fn)
    ext = Path(display_name).suffix.lower() or Path(fn).suffix.lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail=f"Недопустимый тип файла. Разрешены: {', '.join(sorted(_ALLOWED_EXT))}",
        )
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл.")
    if len(raw) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Файл слишком большой. Максимум 100 МБ.")

    stored, dest = _allocate_stored_path(display_name)
    dest.write_bytes(raw)

    note = (comment or "").strip() or None
    if note and len(note) > 4000:
        note = note[:4000]

    row = WikiRagDocument(
        original_filename=display_name[:512],
        stored_filename=stored[:512],
        mime_type=(file.content_type or "").strip()[:128] or None,
        size_bytes=len(raw),
        comment=note,
        uploaded_by_id=current.id,
        index_status=INDEX_PENDING,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row, attribute_names=["uploaded_by"])
    row.uploaded_by = current
    _queue_index_if_enabled(row.id)
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

    try:
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
    except Exception:
        return WikiRagDocumentContentOut(
            id=row.id,
            original_filename=row.original_filename,
            kind="binary",
            editable=False,
            content=None,
            truncated=False,
            hint="Файл пустой или повреждён. Его можно скачать или удалить.",
        )
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
    row.index_status = INDEX_PENDING
    row.index_error = None
    await db.commit()
    _queue_index_if_enabled(doc_id)
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


@router.post("/{doc_id}/reindex", response_model=WikiRagReindexOut)
async def reindex_document(
    doc_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_doc_row(doc_id, db)
    row.index_status = INDEX_PENDING
    row.index_error = None
    await db.commit()
    wikirag_index_queue.enqueue(doc_id)
    return WikiRagReindexOut(
        ok=True,
        document_id=doc_id,
        total=1,
        indexed=0,
        failed=0,
        index_status=INDEX_PENDING,
        detail="Переиндексация документа запущена",
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
    if body.comment is not None:
        note = body.comment.strip() or None
        if note and len(note) > 4000:
            note = note[:4000]
        row.comment = note
    if body.original_filename is not None:
        new_display = _normalize_relative_path(body.original_filename, row.original_filename)
        old_display = str(row.original_filename).replace("\\", "/")
        if new_display != old_display:
            clash = (
                await db.execute(
                    select(WikiRagDocument.id).where(
                        WikiRagDocument.original_filename == new_display[:512],
                        WikiRagDocument.id != doc_id,
                    )
                )
            ).scalar_one_or_none()
            if clash is not None:
                raise HTTPException(status_code=409, detail="Документ с таким путём уже есть.")
            old_stored = str(row.stored_filename).replace("\\", "/")
            leaf = Path(old_stored).name
            parent = Path(new_display).parent
            if str(parent) in (".", ""):
                new_stored = leaf
            else:
                new_stored = str(parent / leaf).replace("\\", "/")
            src = _storage_dir() / old_stored
            dest = _storage_dir() / new_stored
            _assert_under_storage(src)
            _assert_under_storage(dest)
            if src.is_file() and src.resolve() != dest.resolve():
                dest.parent.mkdir(parents=True, exist_ok=True)
                if dest.exists():
                    raise HTTPException(status_code=409, detail="Файл назначения уже существует на диске.")
                try:
                    shutil.move(str(src), str(dest))
                except OSError as e:
                    raise HTTPException(status_code=409, detail=f"Не удалось переместить файл: {e}") from e
            row.original_filename = new_display[:512]
            row.stored_filename = new_stored[:512]
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
        filename=Path(row.original_filename).name,
    )


@router.delete("/{doc_id}", status_code=204)
async def delete_document(
    doc_id: int,
    _: User = Depends(get_current_editor_or_superuser),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_doc_row(doc_id, db, require_file=False)
    await _delete_document_row(row, db)
    await db.commit()
    _unlink_doc_file(row)
