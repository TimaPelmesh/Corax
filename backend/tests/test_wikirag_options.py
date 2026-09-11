import json
from pathlib import Path

from app.wikirag_lm import ollama_num_ctx
from app.wikirag_options import (
    clamp_lm_context_tokens,
    get_auto_index,
    get_embed_model,
    get_lm_context_tokens,
    set_auto_index,
    set_embed_model,
    set_lm_context_tokens,
)


def test_embed_model_persists(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_dir", str(tmp_path))
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_embed_model", "bge-m3")
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_auto_index", False)
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_lm_context_tokens", 0)

    assert get_embed_model() == "bge-m3"
    assert get_auto_index() is False

    assert set_embed_model("nomic-embed-text") == "nomic-embed-text"
    assert get_embed_model() == "nomic-embed-text"
    assert set_auto_index(True) is True
    assert get_auto_index() is True

    raw = json.loads((tmp_path / "wiki_rag_options.json").read_text(encoding="utf-8"))
    assert raw["embed_model"] == "nomic-embed-text"
    assert raw["auto_index"] is True


def test_lm_context_tokens_ui_overrides_env(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_dir", str(tmp_path))
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_lm_context_tokens", 8192)

    assert get_lm_context_tokens() == 8192
    assert ollama_num_ctx() == 8192

    assert set_lm_context_tokens(16384) == 16384
    assert get_lm_context_tokens() == 16384
    assert ollama_num_ctx() == 16384

    assert set_lm_context_tokens(0) == 0
    assert get_lm_context_tokens() == 0
    assert clamp_lm_context_tokens(100) == 2048
    assert clamp_lm_context_tokens(999999) == 32768
    assert clamp_lm_context_tokens("nope") == 0
