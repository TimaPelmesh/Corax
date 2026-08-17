from __future__ import annotations

import base64
import re
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

_TEXT_EXT = {".txt", ".md", ".csv"}
_EDITABLE_EXT = _TEXT_EXT
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
# UI / chat preview — keep bounded so the viewer stays responsive.
_PREVIEW_MAX_CHARS = 120_000
_EXTRACT_MAX_CHARS = 80_000
# Indexing (classic RAG like Ollama script) — allow large KB dumps (~20M chars).
_INDEX_MAX_CHARS = 20_000_000
_INDEX_EXTRACT_MAX_CHARS = 2_000_000

_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def file_ext(name: str) -> str:
    return Path(name).suffix.lower()


def is_editable_filename(name: str) -> bool:
    return file_ext(name) in _EDITABLE_EXT


def _decode_text(raw: bytes) -> str:
    for enc in ("utf-8", "utf-8-sig", "cp1251", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _truncate(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit] + "\n\n… [обрезано]", True


def _extract_docx(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as zf:
            xml = zf.read("word/document.xml")
        root = ET.fromstring(xml)
        parts: list[str] = []
        for node in root.iter(f"{_W_NS}t"):
            if node.text:
                parts.append(node.text)
            if node.tail:
                parts.append(node.tail)
        return "\n".join("".join(parts).splitlines())
    except (OSError, zipfile.BadZipFile, ET.ParseError, KeyError, ValueError):
        return ""


def _extract_xlsx(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as zf:
            shared: list[str] = []
            if "xl/sharedStrings.xml" in zf.namelist():
                root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
                for si in root:
                    texts = [t.text or "" for t in si.iter() if t.tag.endswith("}t") and t.text]
                    shared.append("".join(texts))
            sheet_names = sorted(n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
            chunks: list[str] = []
            for sheet in sheet_names[:3]:
                root = ET.fromstring(zf.read(sheet))
                row_vals: list[str] = []
                for c in root.iter():
                    if not c.tag.endswith("}c"):
                        continue
                    cell_type = c.get("t")
                    val_node = next((ch for ch in c if ch.tag.endswith("}v")), None)
                    if val_node is None or val_node.text is None:
                        continue
                    text = val_node.text
                    if cell_type == "s":
                        try:
                            text = shared[int(text)]
                        except (IndexError, ValueError):
                            pass
                    row_vals.append(text)
                if row_vals:
                    chunks.append(" | ".join(row_vals[:200]))
            return "\n".join(chunks)
    except (OSError, zipfile.BadZipFile, ET.ParseError, KeyError, ValueError):
        return ""


def _extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return "[PDF: установите пакет pypdf на сервере для извлечения текста]"
    try:
        reader = PdfReader(str(path))
        parts: list[str] = []
        for page in reader.pages[:40]:
            parts.append(page.extract_text() or "")
        return "\n\n".join(parts)
    except Exception:
        return ""


def extract_plaintext(
    path: Path,
    original_filename: str,
    *,
    for_index: bool = False,
) -> tuple[str, str, bool]:
    """Returns (kind, text, truncated). kind: text|image|binary.

    Preview stays capped; indexing uses a much higher limit so large MD dumps
    are embedded like DirectoryLoader + RecursiveCharacterTextSplitter scripts.
    """
    text_limit = _INDEX_MAX_CHARS if for_index else _PREVIEW_MAX_CHARS
    extract_limit = _INDEX_EXTRACT_MAX_CHARS if for_index else _EXTRACT_MAX_CHARS
    ext = file_ext(original_filename)
    if ext in _IMAGE_EXT:
        return "image", "", False
    if ext in _TEXT_EXT:
        raw = path.read_bytes()
        text, truncated = _truncate(_decode_text(raw), text_limit)
        return "text", text, truncated
    if ext == ".docx":
        text, truncated = _truncate(_extract_docx(path), extract_limit)
        return "text", text, truncated
    if ext == ".doc":
        return "binary", "[Формат .doc не поддерживается для просмотра. Сохраните как .docx или .pdf.]", False
    if ext == ".xlsx":
        text, truncated = _truncate(_extract_xlsx(path), extract_limit)
        return "text", text, truncated
    if ext == ".xls":
        return "binary", "[Формат .xls не поддерживается для просмотра. Сохраните как .xlsx.]", False
    if ext == ".pdf":
        text, truncated = _truncate(_extract_pdf(path), extract_limit)
        return "text", text, truncated
    raw = path.read_bytes()
    if b"\x00" in raw[:4096]:
        return "binary", "[Бинарный файл — просмотр недоступен, только скачивание.]", False
    text, truncated = _truncate(_decode_text(raw), min(text_limit, 20_000 if not for_index else text_limit))
    return "text", text, truncated


def read_editable_content(path: Path) -> str:
    return _decode_text(path.read_bytes())


def write_editable_content(path: Path, content: str) -> int:
    data = content.encode("utf-8")
    if len(data) > _MAX_BYTES:
        raise ValueError("Слишком большой файл")
    path.write_bytes(data)
    return len(data)


_MAX_BYTES = 2 * 1024 * 1024


def image_data_url(path: Path, mime: str | None) -> str:
    raw = path.read_bytes()
    if len(raw) > 6 * 1024 * 1024:
        return ""
    mt = (mime or "").strip() or "image/png"
    b64 = base64.standard_b64encode(raw).decode("ascii")
    return f"data:{mt};base64,{b64}"


def context_keywords(query: str) -> set[str]:
    """Недорогие ключевые слова для выбора фрагментов без embeddings."""
    ignored = {
        "что", "как", "где", "это", "для", "про", "или", "все", "есть", "мне",
        "нужен", "нужно", "покажи", "какой", "какая", "какие", "данные",
    }
    return {
        token.lower()
        for token in re.findall(r"[a-zа-яё0-9_-]{3,}", (query or "").lower())
        if token.lower() not in ignored
    }


def excerpt_for_context(text: str, limit: int = 4000, *, query: str = "") -> str:
    clean = re.sub(r"\s+", " ", (text or "").strip())
    if len(clean) <= limit:
        return clean
    keywords = context_keywords(query)
    if keywords:
        low = clean.lower()
        positions = [low.find(word) for word in keywords if low.find(word) >= 0]
        if positions:
            start = max(0, min(positions) - max(120, limit // 5))
            end = min(len(clean), start + limit)
            excerpt = clean[start:end]
            return ("… " if start else "") + excerpt + (" …" if end < len(clean) else "")
    return clean[: limit - 1] + "…"
