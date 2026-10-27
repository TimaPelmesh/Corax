from __future__ import annotations

import pytest

from app.svg_export import SvgExportError, svg_export_available, svg_to_pdf, svg_to_png

MINI_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">
  <rect width="100" height="50" fill="#336699"/>
</svg>"""


def test_svg_export_available_reports_engine():
    ok, reason = svg_export_available()
    if ok:
        assert reason is None
    else:
        assert reason and "cairosvg" in reason.lower()


def test_svg_to_png_empty_raises():
    with pytest.raises(SvgExportError, match="Пустой"):
        svg_to_png("   ")


@pytest.mark.skipif(not svg_export_available()[0], reason="cairosvg not installed")
def test_svg_to_png_produces_bytes():
    data = svg_to_png(MINI_SVG)
    assert isinstance(data, bytes)
    assert data[:8] == b"\x89PNG\r\n\x1a\n"


@pytest.mark.skipif(not svg_export_available()[0], reason="cairosvg not installed")
def test_svg_to_pdf_produces_bytes():
    data = svg_to_pdf(MINI_SVG)
    assert isinstance(data, bytes)
    assert data.startswith(b"%PDF")
