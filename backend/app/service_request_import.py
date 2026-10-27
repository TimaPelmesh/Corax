"""Bounded background import for GLPI and CORAX service-request files."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import re
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import and_, delete, insert, or_, select

from app.database import AsyncSessionLocal
from app.models import Computer, ServiceRequest, User, service_request_assignees
from app.observability import get_logger
from app.search_index import index_service_requests
from app.service_request_tickets import (
    ensure_ticket_numbers,
    is_service_request_closed,
    stamp_closed_at_if_needed,
)

log = get_logger("corax.service_request_import")

ImportKind = Literal["glpi_csv", "corax_json"]
ImportPhase = Literal["idle", "parsing", "importing", "done", "error"]

MAX_IMPORT_BYTES = 50 * 1024 * 1024
MAX_IMPORT_ROWS = 50_000
IMPORT_BATCH_SIZE = 250
ERROR_SAMPLE_LIMIT = 50
_GLPI_DT_FMT = "%d-%m-%Y %H:%M"
_BR_RE = re.compile(r"\s*<br\s*/?>\s*", re.IGNORECASE)
_GLPI_REQUIRED_HEADERS = (
    "ID",
    "Заголовок",
    "Статус",
    "Последнее изменение",
    "Инициатор запроса - Инициатор запроса",
    "Дата открытия",
    "Приоритет",
    "Категория",
)


@dataclass(frozen=True)
class ImportRecord:
    row_number: int
    title: str
    glpi_id: int | None = None
    description: str | None = None
    status: str = "open"
    priority: str = "normal"
    glpi_status: str | None = None
    glpi_priority: str | None = None
    glpi_updated_at: datetime | None = None
    external_source: str | None = None
    external_id: str | None = None
    external_url: str | None = None
    requester_name: str | None = None
    category: str | None = None
    location: str | None = None
    opened_at: datetime | None = None
    planned_close_at: datetime | None = None
    closed_at: datetime | None = None
    computer_id: int | None = None
    assignee_ids: tuple[int, ...] | None = None


@dataclass(frozen=True)
class ParsedImport:
    records: tuple[ImportRecord, ...]
    rows_total: int
    skipped: int = 0
    errors: tuple[str, ...] = ()


@dataclass
class ImportJobState:
    running: bool = False
    kind: ImportKind | None = None
    phase: ImportPhase = "idle"
    progress: int = 0
    message: str = ""
    filename: str | None = None
    rows_total: int = 0
    processed: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors_count: int = 0
    errors_sample: list[str] = field(default_factory=list)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None


def _text(value: object | None, limit: int | None = None) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    if not result:
        return None
    return result[:limit] if limit is not None else result


def _parse_datetime(value: object | None) -> datetime | None:
    text = _text(value)
    if not text:
        return None
    for fmt in (_GLPI_DT_FMT, "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _norm_requester(value: object | None) -> str | None:
    text = _text(value)
    if not text:
        return None
    return re.sub(r"\s+", " ", _BR_RE.sub(" ", text)).strip()[:255] or None


def _map_priority(value: str | None) -> str:
    low = (value or "").strip().casefold()
    if "низк" in low or low == "low":
        return "low"
    if "высок" in low or "очень высокий" in low or low == "high":
        return "high"
    return "normal"


def _map_status(value: str | None) -> str:
    low = (value or "").strip().casefold()
    if any(token in low for token in ("закрыт", "решен", "решён", "closed", "solved")):
        return "done"
    if any(token in low for token in ("обработ", "назнач", "progress", "processing")):
        return "in_progress"
    if any(token in low for token in ("отмен", "cancel")):
        return "cancelled"
    return "open"


def _decode_file(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("Не удалось прочитать файл: используйте UTF-8 или Windows-1251.")


def parse_glpi_csv(raw: bytes) -> ParsedImport:
    text = _decode_file(raw)
    reader = csv.DictReader(io.StringIO(text), delimiter=";", quotechar='"')
    headers = reader.fieldnames or []
    missing = [header for header in _GLPI_REQUIRED_HEADERS if header not in headers]
    if missing:
        raise ValueError(f"CSV не похож на GLPI: нет колонок: {', '.join(missing)}")

    by_glpi_id: dict[int, ImportRecord] = {}
    errors: list[str] = []
    skipped = 0
    rows_total = 0
    for row_number, row in enumerate(reader, start=2):
        rows_total += 1
        if rows_total > MAX_IMPORT_ROWS:
            raise ValueError(f"В файле больше {MAX_IMPORT_ROWS:,} строк.")
        try:
            gid_text = _text(row.get("ID"))
            title = _text(row.get("Заголовок"), 255)
            if not gid_text or not title:
                skipped += 1
                continue
            gid = int(gid_text.strip('"'))
            glpi_status = _text(row.get("Статус"), 64)
            glpi_priority = _text(row.get("Приоритет"), 64)
            candidate = ImportRecord(
                row_number=row_number,
                glpi_id=gid,
                title=title,
                status=_map_status(glpi_status),
                priority=_map_priority(glpi_priority),
                glpi_status=glpi_status,
                glpi_priority=glpi_priority,
                glpi_updated_at=_parse_datetime(row.get("Последнее изменение")),
                requester_name=_norm_requester(row.get("Инициатор запроса - Инициатор запроса")),
                category=_text(row.get("Категория"), 255),
                location=_text(row.get("Местоположение"), 255),
                opened_at=_parse_datetime(row.get("Дата открытия")),
            )
            current = by_glpi_id.get(gid)
            if current is None:
                by_glpi_id[gid] = candidate
                continue
            skipped += 1
            current_date = current.glpi_updated_at or datetime.min
            candidate_date = candidate.glpi_updated_at or datetime.min
            if candidate_date >= current_date:
                by_glpi_id[gid] = candidate
        except (TypeError, ValueError) as exc:
            errors.append(f"строка {row_number}: {exc}")
            skipped += 1

    records = tuple(sorted(by_glpi_id.values(), key=lambda item: item.glpi_id or 0))
    return ParsedImport(records, rows_total, skipped, tuple(errors))


def parse_corax_json(raw: bytes) -> ParsedImport:
    try:
        payload: Any = json.loads(_decode_file(raw))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Некорректный JSON: {exc.msg}.") from exc
    items = payload if isinstance(payload, list) else payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise ValueError("JSON должен содержать массив заявок или объект с полем items.")
    if len(items) > MAX_IMPORT_ROWS:
        raise ValueError(f"В файле больше {MAX_IMPORT_ROWS:,} строк.")

    records: list[ImportRecord] = []
    errors: list[str] = []
    skipped = 0
    for offset, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            errors.append(f"запись {offset}: ожидается объект")
            skipped += 1
            continue
        title = _text(item.get("title"), 255)
        if not title:
            errors.append(f"запись {offset}: нет заголовка")
            skipped += 1
            continue
        try:
            glpi_id = int(item["glpi_id"]) if item.get("glpi_id") not in (None, "") else None
            computer_id = int(item["computer_id"]) if item.get("computer_id") not in (None, "") else None
            assignee_ids = (
                tuple(dict.fromkeys(int(value) for value in item.get("assignee_ids", [])))
                if isinstance(item.get("assignee_ids", []), list)
                else ()
            )
        except (TypeError, ValueError):
            errors.append(f"запись {offset}: некорректный числовой идентификатор")
            skipped += 1
            continue
        records.append(
            ImportRecord(
                row_number=offset,
                title=title,
                glpi_id=glpi_id,
                description=_text(item.get("description")),
                status=_text(item.get("status"), 32) or "open",
                priority=_text(item.get("priority"), 32) or "normal",
                glpi_status=_text(item.get("glpi_status"), 64),
                glpi_priority=_text(item.get("glpi_priority"), 64),
                glpi_updated_at=_parse_datetime(item.get("glpi_updated_at")),
                external_source=_text(item.get("external_source"), 32),
                external_id=_text(item.get("external_id"), 128),
                external_url=_text(item.get("external_url"), 512),
                requester_name=_text(item.get("requester_name"), 255),
                category=_text(item.get("category"), 255),
                location=_text(item.get("location"), 255),
                opened_at=_parse_datetime(item.get("opened_at")),
                planned_close_at=_parse_datetime(item.get("planned_close_at")),
                closed_at=_parse_datetime(item.get("closed_at")),
                computer_id=computer_id,
                assignee_ids=assignee_ids,
            )
        )
    return ParsedImport(tuple(records), len(items), skipped, tuple(errors))


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _same_datetime(left: datetime | None, right: datetime | None) -> bool:
    if left is None or right is None:
        return left is right
    if left.tzinfo is not None and right.tzinfo is not None:
        return left.astimezone(timezone.utc) == right.astimezone(timezone.utc)
    if left.tzinfo is not None:
        left = left.astimezone().replace(tzinfo=None)
    if right.tzinfo is not None:
        right = right.astimezone().replace(tzinfo=None)
    return left == right


def _apply_record(row: ServiceRequest, record: ImportRecord, *, is_new: bool) -> bool:
    changed = is_new
    was_closed = False if is_new else is_service_request_closed(row)
    values: dict[str, object | None] = {
        "title": record.title,
        "status": record.status,
        "priority": record.priority,
        "glpi_status": record.glpi_status,
        "glpi_priority": record.glpi_priority,
        "glpi_updated_at": record.glpi_updated_at,
        "requester_name": record.requester_name,
        "category": record.category,
    }
    if record.glpi_id is not None:
        values["glpi_id"] = record.glpi_id
    if record.location is not None:
        values["location"] = record.location
    if record.opened_at is not None:
        values["opened_at"] = record.opened_at
    if record.description is not None:
        values["description"] = record.description
    if record.external_source is not None:
        values["external_source"] = record.external_source
    if record.external_id is not None:
        values["external_id"] = record.external_id
    if record.external_url is not None:
        values["external_url"] = record.external_url
    if record.planned_close_at is not None:
        values["planned_close_at"] = record.planned_close_at
    if record.closed_at is not None:
        values["closed_at"] = record.closed_at
    if record.computer_id is not None:
        values["computer_id"] = record.computer_id

    for field_name, value in values.items():
        current = getattr(row, field_name)
        equal = (
            _same_datetime(current, value)
            if isinstance(current, datetime) or isinstance(value, datetime)
            else current == value
        )
        if not equal:
            setattr(row, field_name, value)
            changed = True
    stamp_closed_at_if_needed(row, was_closed=was_closed)
    return changed


async def _process_batch(records: list[ImportRecord], created_by_id: int) -> tuple[int, int, int]:
    glpi_ids = [record.glpi_id for record in records if record.glpi_id is not None]
    external_keys = {
        (record.external_source, record.external_id)
        for record in records
        if record.external_source and record.external_id
    }
    clauses = []
    if glpi_ids:
        clauses.append(ServiceRequest.glpi_id.in_(glpi_ids))
    for source, external_id in external_keys:
        clauses.append(and_(ServiceRequest.external_source == source, ServiceRequest.external_id == external_id))

    async with AsyncSessionLocal() as db:
        requested_computer_ids = {record.computer_id for record in records if record.computer_id is not None}
        valid_computer_ids = (
            set(
                (
                    await db.execute(select(Computer.id).where(Computer.id.in_(requested_computer_ids)))
                ).scalars()
            )
            if requested_computer_ids
            else set()
        )
        requested_assignee_ids = {
            user_id
            for record in records
            for user_id in (record.assignee_ids or ())
        }
        valid_assignee_ids = (
            set(
                (
                    await db.execute(select(User.id).where(User.id.in_(requested_assignee_ids)))
                ).scalars()
            )
            if requested_assignee_ids
            else set()
        )
        existing_rows = (
            (await db.execute(select(ServiceRequest).where(or_(*clauses)))).scalars().all()
            if clauses
            else []
        )
        by_glpi = {row.glpi_id: row for row in existing_rows if row.glpi_id is not None}
        by_external = {
            (row.external_source, row.external_id): row
            for row in existing_rows
            if row.external_source and row.external_id
        }
        touched: list[ServiceRequest] = []
        assignees_by_row: dict[ServiceRequest, tuple[int, ...]] = {}
        created = 0
        updated = 0
        skipped = 0
        for record in records:
            if record.computer_id is not None and record.computer_id not in valid_computer_ids:
                record = replace(record, computer_id=None)
            row = by_glpi.get(record.glpi_id) if record.glpi_id is not None else None
            if row is None and record.external_source and record.external_id:
                row = by_external.get((record.external_source, record.external_id))
            if row is None:
                row = ServiceRequest(
                    title=record.title,
                    status=record.status,
                    priority=record.priority,
                    created_by_id=created_by_id,
                )
                db.add(row)
                _apply_record(row, record, is_new=True)
                if record.glpi_id is not None:
                    by_glpi[record.glpi_id] = row
                if record.external_source and record.external_id:
                    by_external[(record.external_source, record.external_id)] = row
                touched.append(row)
                if record.assignee_ids is not None:
                    assignees_by_row[row] = tuple(
                        user_id for user_id in record.assignee_ids if user_id in valid_assignee_ids
                    )
                created += 1
            elif _apply_record(row, record, is_new=False):
                touched.append(row)
                if record.assignee_ids is not None:
                    assignees_by_row[row] = tuple(
                        user_id for user_id in record.assignee_ids if user_id in valid_assignee_ids
                    )
                updated += 1
            else:
                if record.assignee_ids is not None:
                    touched.append(row)
                    assignees_by_row[row] = tuple(
                        user_id for user_id in record.assignee_ids if user_id in valid_assignee_ids
                    )
                    updated += 1
                else:
                    skipped += 1

        if touched:
            await ensure_ticket_numbers(db, touched)
            await db.flush()
            await index_service_requests(db, touched)
        if assignees_by_row:
            request_ids = [row.id for row in assignees_by_row if row.id is not None]
            if request_ids:
                await db.execute(
                    delete(service_request_assignees).where(
                        service_request_assignees.c.request_id.in_(request_ids)
                    )
                )
                association_rows = [
                    {"request_id": row.id, "user_id": user_id}
                    for row, user_ids in assignees_by_row.items()
                    if row.id is not None
                    for user_id in user_ids
                ]
                if association_rows:
                    await db.execute(insert(service_request_assignees), association_rows)
        await db.commit()
        return created, updated, skipped


class ServiceRequestImportRunner:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self.state = ImportJobState()

    def snapshot(self) -> dict[str, Any]:
        state = self.state

        def iso(value: datetime | None) -> str | None:
            if value is None:
                return None
            return _utc(value).isoformat().replace("+00:00", "Z")  # type: ignore[union-attr]

        return {
            "running": state.running,
            "kind": state.kind,
            "phase": state.phase,
            "progress": state.progress,
            "message": state.message,
            "filename": state.filename,
            "rows_total": state.rows_total,
            "processed": state.processed,
            "created": state.created,
            "updated": state.updated,
            "skipped": state.skipped,
            "errors_count": state.errors_count,
            "errors_sample": list(state.errors_sample),
            "started_at": iso(state.started_at),
            "finished_at": iso(state.finished_at),
            "error": state.error,
        }

    async def start(
        self,
        *,
        kind: ImportKind,
        raw: bytes,
        filename: str,
        created_by_id: int,
    ) -> dict[str, Any]:
        if not raw:
            raise ValueError("Пустой файл.")
        if len(raw) > MAX_IMPORT_BYTES:
            raise ValueError(f"Файл больше {MAX_IMPORT_BYTES // (1024 * 1024)} МБ.")
        async with self._lock:
            if self.state.running:
                raise RuntimeError("Импорт заявок уже выполняется.")
            self.state = ImportJobState(
                running=True,
                kind=kind,
                phase="parsing",
                progress=1,
                message="Проверка и подготовка файла…",
                filename=filename,
                started_at=datetime.now(timezone.utc),
            )
            self._task = asyncio.create_task(
                self._run(kind=kind, raw=raw, created_by_id=created_by_id),
                name=f"service-request-import-{kind}",
            )
            return self.snapshot()

    async def _run(self, *, kind: ImportKind, raw: bytes, created_by_id: int) -> None:
        try:
            parser = parse_glpi_csv if kind == "glpi_csv" else parse_corax_json
            parsed = await asyncio.to_thread(parser, raw)
            self.state.rows_total = parsed.rows_total
            self.state.skipped = parsed.skipped
            self.state.errors_count = len(parsed.errors)
            self.state.errors_sample = list(parsed.errors[:ERROR_SAMPLE_LIMIT])
            self.state.phase = "importing"
            self.state.progress = 5
            self.state.message = "Импорт заявок пакетами…"

            records = parsed.records
            total = len(records)
            successful_batches = 0
            failed_batches = 0
            if total == 0:
                self.state.progress = 100
                self.state.message = "В файле нет подходящих заявок."
            for start in range(0, total, IMPORT_BATCH_SIZE):
                batch = list(records[start : start + IMPORT_BATCH_SIZE])
                try:
                    created, updated, skipped = await _process_batch(batch, created_by_id)
                    self.state.created += created
                    self.state.updated += updated
                    self.state.skipped += skipped
                    successful_batches += 1
                except Exception as exc:
                    failed_batches += 1
                    self.state.skipped += len(batch)
                    self.state.errors_count += 1
                    if len(self.state.errors_sample) < ERROR_SAMPLE_LIMIT:
                        self.state.errors_sample.append(
                            f"пакет {start + 1}–{start + len(batch)}: {str(exc)[:300]}"
                        )
                    log.warning("service_request_import_batch_failed", extra={"error": str(exc)[:400]})
                self.state.processed = min(total, start + len(batch))
                self.state.progress = 5 + int(94 * self.state.processed / max(1, total))
                self.state.message = (
                    f"Обработано {self.state.processed:,} из {total:,}. "
                    f"Создано {self.state.created:,}, обновлено {self.state.updated:,}."
                )
                await asyncio.sleep(0)

            if failed_batches and not successful_batches:
                raise RuntimeError("База данных отклонила все пакеты импорта.")
            self.state.phase = "done"
            self.state.progress = 100
            self.state.message = (
                f"Импорт завершён: создано {self.state.created:,}, "
                f"обновлено {self.state.updated:,}, пропущено {self.state.skipped:,}."
            )
            self.state.error = None
        except Exception as exc:
            self.state.phase = "error"
            self.state.progress = 100
            self.state.error = str(exc)[:400]
            self.state.message = f"Ошибка импорта: {self.state.error}"
            log.warning("service_request_import_failed", extra={"error": str(exc)[:400]})
        finally:
            self.state.running = False
            self.state.finished_at = datetime.now(timezone.utc)


service_request_import_runner = ServiceRequestImportRunner()
