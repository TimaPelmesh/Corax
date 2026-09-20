from __future__ import annotations

from pathlib import Path

from helpers import unique_hostname
from starlette.testclient import TestClient

from app.routers.wikirag import _storage_dir
from app.wikirag_content import extract_plaintext


def _stored_files(name: str) -> list[Path]:
    return [p for p in _storage_dir().rglob("*") if p.is_file() and name in p.name]


def test_extract_plaintext_empty_broken_office_and_pdf(tmp_path: Path):
    empty_docx = tmp_path / "broken.docx"
    empty_docx.write_bytes(b"")
    kind, text, _ = extract_plaintext(empty_docx, "broken.docx")
    assert kind == "text"
    assert text == ""

    empty_pdf = tmp_path / "broken.pdf"
    empty_pdf.write_bytes(b"")
    kind, text, _ = extract_plaintext(empty_pdf, "broken.pdf")
    assert kind == "text"
    assert text == ""


def test_wiki_rag_delete_missing_disk_file(client: TestClient, auth_headers: dict[str, str]):
    name = f"ghost-{unique_hostname('rag')}.md"
    created = client.post(
        "/api/v1/wiki-rag",
        headers=auth_headers,
        files={"file": (name, b"# hello\n", "text/markdown")},
    )
    assert created.status_code == 200, created.text
    doc_id = created.json()["id"]

    matches = _stored_files(name)
    assert matches
    for p in matches:
        p.unlink()

    missing = client.get(f"/api/v1/wiki-rag/{doc_id}/file", headers=auth_headers)
    assert missing.status_code == 404

    deleted = client.delete(f"/api/v1/wiki-rag/{doc_id}", headers=auth_headers)
    assert deleted.status_code == 204, deleted.text

    listed = client.get("/api/v1/wiki-rag", headers=auth_headers)
    assert listed.status_code == 200
    assert all(row["id"] != doc_id for row in listed.json())


def test_wiki_rag_delete_empty_file(client: TestClient, auth_headers: dict[str, str]):
    name = f"empty-{unique_hostname('rag')}.md"
    created = client.post(
        "/api/v1/wiki-rag",
        headers=auth_headers,
        files={"file": (name, b"# x\n", "text/markdown")},
    )
    assert created.status_code == 200, created.text
    doc_id = created.json()["id"]

    matches = _stored_files(name)
    assert matches
    matches[0].write_bytes(b"")

    deleted = client.delete(f"/api/v1/wiki-rag/{doc_id}", headers=auth_headers)
    assert deleted.status_code == 204, deleted.text
    assert not matches[0].exists()

    listed = client.get("/api/v1/wiki-rag", headers=auth_headers)
    assert listed.status_code == 200
    assert all(row["id"] != doc_id for row in listed.json())
