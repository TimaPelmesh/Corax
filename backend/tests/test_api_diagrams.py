from __future__ import annotations

from starlette.testclient import TestClient

from app.svg_export import svg_export_available


def test_converter_status(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/diagrams/converter-status", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["engine"] == "cairosvg"
    assert body["ok"] is svg_export_available()[0]


def test_diagrams_list(client: TestClient, auth_headers: dict[str, str]):
    r = client.get("/api/v1/diagrams", headers=auth_headers)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_import_visio_gone(client: TestClient, auth_headers: dict[str, str]):
    r = client.post("/api/v1/diagrams/import-visio", headers=auth_headers)
    assert r.status_code == 410
    assert "Visio" in r.json()["detail"]


def test_floor_blank_and_exports(client: TestClient, auth_headers: dict[str, str]):
    created = client.post(
        "/api/v1/diagrams/floor-blank",
        headers=auth_headers,
        json={"title": "Тест этаж"},
    )
    assert created.status_code == 200
    diagram_id = created.json()["id"]

    svg = client.get(f"/api/v1/diagrams/{diagram_id}/svg", headers=auth_headers)
    assert svg.status_code == 200
    assert "svg" in svg.headers.get("content-type", "").lower()
    assert "<svg" in svg.text

    if not svg_export_available()[0]:
        return

    png = client.get(f"/api/v1/diagrams/{diagram_id}/export.png", headers=auth_headers)
    assert png.status_code == 200
    assert png.content[:8] == b"\x89PNG\r\n\x1a\n"

    pdf = client.get(f"/api/v1/diagrams/{diagram_id}/export.pdf", headers=auth_headers)
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")

    layout = client.get(f"/api/v1/diagrams/{diagram_id}/export.json", headers=auth_headers)
    assert layout.status_code == 200
    body = layout.json()
    assert body["diagram_id"] == diagram_id
    assert body["title"] == "Тест этаж"
    assert body["layout"]["version"] == 1
