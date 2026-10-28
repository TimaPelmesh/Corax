import json
from pathlib import Path

from app.wikirag_lm import ollama_num_ctx
from app.wikirag_options import (
    clamp_lm_context_tokens,
    get_auto_index,
    get_embed_base_url,
    get_embed_model,
    get_llm_servers,
    get_lm_context_tokens,
    llm_servers_configured,
    set_auto_index,
    set_embed_base_url,
    set_embed_model,
    set_llm_servers,
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


def test_llm_servers_are_separate_from_embeddings(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.wikirag_options.settings.wiki_rag_dir", str(tmp_path))
    monkeypatch.setattr("app.wikirag_index.settings.wiki_rag_embed_base_url", "http://10.1.0.2:11434/v1")

    from app.wikirag_index import embed_base_url

    assert get_llm_servers() == []
    assert llm_servers_configured() is False
    assert get_embed_base_url() == ""
    assert embed_base_url() == "http://10.1.0.2:11434/v1"

    saved = set_llm_servers(
        [
            {"id": "chat0001", "label": "Чат", "base_url": "http://10.0.0.5:11434"},
            {"id": "embed001", "label": "Векторы", "base_url": "http://10.0.0.8:1234/v1"},
        ]
    )
    assert saved[0]["base_url"] == "http://10.0.0.5:11434/v1"
    assert saved[1]["label"] == "Векторы"
    assert get_llm_servers()[0]["id"] == "chat0001"
    assert llm_servers_configured() is True

    assert set_embed_base_url("http://10.0.0.8:1234") == "http://10.0.0.8:1234/v1"
    assert embed_base_url() == "http://10.0.0.8:1234/v1"
    assert set_embed_base_url("") == ""
    assert embed_base_url() == "http://10.1.0.2:11434/v1"

    try:
        set_llm_servers(
            [
                {"id": "chat0001", "label": "A", "base_url": "http://10.0.0.5:11434/v1"},
                {"id": "chat0002", "label": "B", "base_url": "http://10.0.0.5:11434"},
            ]
        )
        raised = False
    except ValueError:
        raised = True
    assert raised

    try:
        set_llm_servers([{"id": "chat0001", "label": "A", "base_url": "ftp://10.0.0.5/model"}])
        raised = False
    except ValueError:
        raised = True
    assert raised
