"""SVG → PNG/PDF without LibreOffice (uses cairosvg)."""
from __future__ import annotations

from io import BytesIO


class SvgExportError(RuntimeError):
    pass


def svg_export_available() -> tuple[bool, str | None]:
    try:
        import cairosvg  # noqa: F401
    except ImportError:
        return False, "Установите cairosvg: pip install cairosvg (и libcairo2 на Linux)."
    return True, None


def svg_to_png(svg_text: str) -> bytes:
    if not (svg_text or "").strip():
        raise SvgExportError("Пустой SVG")
    ok, reason = svg_export_available()
    if not ok:
        raise SvgExportError(reason or "cairosvg недоступен")
    import cairosvg

    try:
        return cairosvg.svg2png(bytestring=svg_text.encode("utf-8"))
    except Exception as exc:
        raise SvgExportError(f"Не удалось сконвертировать SVG в PNG: {exc}") from exc


def svg_to_pdf(svg_text: str) -> bytes:
    png = svg_to_png(svg_text)
    from fpdf import FPDF

    pdf = FPDF(orientation="L", unit="mm", format="A4")
    pdf.set_margin(0)
    pdf.add_page()
    pdf.image(BytesIO(png), x=0, y=0, w=297)
    out = pdf.output(dest="S")
    if isinstance(out, (bytes, bytearray)):
        return bytes(out)
    return out.encode("latin-1")
