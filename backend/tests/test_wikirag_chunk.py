from app.wikirag_index import chunk_overlap, chunk_size


def test_chunk_defaults_are_1500_300(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "wiki_rag_chunk_size", 1500)
    monkeypatch.setattr(settings, "wiki_rag_chunk_overlap", 300)
    assert chunk_size() == 1500
    assert chunk_overlap() == 300
