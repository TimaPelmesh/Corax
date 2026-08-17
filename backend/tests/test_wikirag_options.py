import json
from pathlib import Path

from app.wikirag_options import get_auto_index, get_embed_model, set_auto_index, set_embed_model


def test_embed_model_persists(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_dir", str(tmp_path))
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_embed_model", "bge-m3")
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_auto_index", False)

    assert get_embed_model() == "bge-m3"
    assert get_auto_index() is False

    assert set_embed_model("nomic-embed-text") == "nomic-embed-text"
    assert get_embed_model() == "nomic-embed-text"
    assert set_auto_index(True) is True
    assert get_auto_index() is True

    raw = json.loads((tmp_path / "wiki_rag_options.json").read_text(encoding="utf-8"))
    assert raw["embed_model"] == "nomic-embed-text"
    assert raw["auto_index"] is True
