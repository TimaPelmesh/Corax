from __future__ import annotations

import asyncio
import json
import random
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models import ServiceRequest
from app.service_request_import import (
    IMPORT_BATCH_SIZE,
    ServiceRequestImportRunner,
    parse_corax_json,
    parse_glpi_csv,
)
from app.service_request_tickets import ensure_ticket_numbers


GLPI_HEADERS = (
    "ID;Заголовок;Местоположение;Статус;Последнее изменение;"
    "Инициатор запроса - Инициатор запроса;Дата открытия;Приоритет;Категория"
)


def _glpi_row(gid: int, title: str, changed: str) -> str:
    return f'{gid};"{title}";Office;Закрыта;{changed};User;01-01-2026 09:00;Высокий;IT'


def test_glpi_parser_handles_10k_shuffled_rows():
    rows = [_glpi_row(index, f"Ticket {index}", "01-01-2026 10:00") for index in range(1, 10_001)]
    random.Random(42).shuffle(rows)

    parsed = parse_glpi_csv((GLPI_HEADERS + "\n" + "\n".join(rows)).encode())

    assert parsed.rows_total == 10_000
    assert len(parsed.records) == 10_000
    assert parsed.records[0].glpi_id == 1
    assert parsed.records[-1].glpi_id == 10_000


def test_glpi_parser_deduplicates_by_id_and_keeps_latest_row():
    rows = [
        _glpi_row(42, "Newest", "03-01-2026 10:00"),
        _glpi_row(7, "Other", "02-01-2026 10:00"),
        _glpi_row(42, "Oldest", "01-01-2026 10:00"),
    ]
    parsed = parse_glpi_csv((GLPI_HEADERS + "\n" + "\n".join(rows)).encode())

    assert parsed.rows_total == 3
    assert len(parsed.records) == 2
    assert parsed.skipped == 1
    assert next(record for record in parsed.records if record.glpi_id == 42).title == "Newest"


def test_corax_json_parser_keeps_row_errors_without_failing_file():
    raw = json.dumps({"items": [{"title": "Valid"}, {"title": ""}, "bad"]}).encode()

    parsed = parse_corax_json(raw)

    assert len(parsed.records) == 1
    assert parsed.skipped == 2
    assert len(parsed.errors) == 2


@pytest.mark.asyncio
async def test_import_runner_processes_bounded_batches(monkeypatch: pytest.MonkeyPatch):
    batch_sizes: list[int] = []

    async def fake_process_batch(records, created_by_id):
        assert created_by_id == 9
        batch_sizes.append(len(records))
        return len(records), 0, 0

    monkeypatch.setattr("app.service_request_import._process_batch", fake_process_batch)
    runner = ServiceRequestImportRunner()
    raw = json.dumps({"items": [{"title": f"Ticket {index}"} for index in range(1001)]}).encode()

    await runner.start(kind="corax_json", raw=raw, filename="tickets.json", created_by_id=9)
    while runner.state.running:
        await asyncio.sleep(0.001)

    assert batch_sizes == [IMPORT_BATCH_SIZE] * 4 + [1]
    assert runner.state.created == 1001
    assert runner.state.processed == 1001
    assert runner.state.phase == "done"


@pytest.mark.asyncio
async def test_import_runner_rejects_parallel_job(monkeypatch: pytest.MonkeyPatch):
    release = asyncio.Event()

    async def slow_process_batch(records, created_by_id):
        await release.wait()
        return len(records), 0, 0

    monkeypatch.setattr("app.service_request_import._process_batch", slow_process_batch)
    runner = ServiceRequestImportRunner()
    raw = json.dumps({"items": [{"title": "Ticket"}]}).encode()
    await runner.start(kind="corax_json", raw=raw, filename="one.json", created_by_id=1)

    with pytest.raises(RuntimeError, match="уже выполняется"):
        await runner.start(kind="corax_json", raw=raw, filename="two.json", created_by_id=1)

    release.set()
    while runner.state.running:
        await asyncio.sleep(0.001)


@pytest.mark.asyncio
async def test_ticket_numbers_are_allocated_with_single_max_query():
    db = MagicMock()
    db.get_bind.return_value.dialect.name = "sqlite"
    db.scalar = AsyncMock(return_value=40)
    first = ServiceRequest(title="A", status="done", priority="normal", created_by_id=1)
    second = ServiceRequest(title="B", status="cancelled", priority="normal", created_by_id=1)
    open_row = ServiceRequest(title="C", status="open", priority="normal", created_by_id=1)

    await ensure_ticket_numbers(db, [first, second, open_row])

    assert first.ticket_no == 41
    assert second.ticket_no == 42
    assert open_row.ticket_no is None
    db.scalar.assert_awaited_once()
