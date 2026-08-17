"""Smoke tests for WikiRAG RAG upgrades (chunk metadata + tools packaging)."""

from app.wikirag_index import RetrievedChunk, _rrf_fuse, chunk_corax_csv, chunk_text, prepare_document_chunks
from app.wikirag_tools import ToolPack, RagSource


def test_chunk_corax_csv_metadata():
    csv_text = "computer_id;hostname;os_name\n1;PC-OLD;Windows 7\n2;PC-NEW;Windows 10\n"
    chunks = chunk_corax_csv(csv_text, source_table="computers", filename="CORAX_компьютеры.csv")
    assert chunks
    assert chunks[0].source_kind == "corax"
    assert chunks[0].source_table == "computers"
    assert "PC-OLD" in chunks[0].text or (chunks[0].meta or {}).get("hostnames")


def test_prepare_document_chunks_corax_csv():
    csv_text = "computer_id;hostname;software_name\n10;HOST-A;Office\n11;HOST-B;1C\n"
    pieces = prepare_document_chunks("CORAX_ПО.csv", "text", csv_text)
    assert pieces
    assert all(p.source_table == "software" for p in pieces)


def test_generic_csv_keeps_rare_value_in_a_single_row_chunk():
    pieces = prepare_document_chunks(
        "тест.csv",
        "text",
        "название;описание\nабаобабы;Редкое слово для проверки поиска\n",
    )
    assert len(pieces) == 1
    assert "абаобабы" in pieces[0].text
    assert "описание=Редкое слово" in pieces[0].text


def test_text_chunk_preserves_markdown_heading_for_each_section():
    pieces = chunk_text("# Раздел\n\nабаобабы встречаются только здесь.\n\n# Другой\n\nОбычный текст.", size=80)
    assert any("Раздел" in piece.text and "абаобабы" in piece.text for piece in pieces)


def test_rrf_promotes_exact_lexical_chunk_also_found_semantically():
    exact = RetrievedChunk(1, "тест.md", "абаобабы", 0.8, 0)
    unrelated = RetrievedChunk(1, "тест.md", "похожие слова", 0.9, 1)
    fused = _rrf_fuse([unrelated, exact], [exact], top_k=2)
    assert fused[0].content == "абаобабы"


def test_tool_pack_sources_for_api():
    pack = ToolPack(context="x")
    pack.sources.append(
        RagSource(
            kind="wiki_chunk",
            label="doc.md · chunk 0",
            document_id=5,
            filename="doc.md",
            chunk_index=0,
            score=0.91,
            excerpt="hello",
        )
    )
    api = pack.sources_for_api()
    assert api[0]["document_id"] == 5
    assert api[0]["score"] == 0.91
