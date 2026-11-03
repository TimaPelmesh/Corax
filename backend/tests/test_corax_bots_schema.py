"""Unit checks for the bot constructor defaults (no HTTP stack)."""

from app.routers.bots import DEFAULT_DIALOGS, _dump_json, _load_json
from app.schemas import CoraxBotCreate, CoraxBotUpdate


def test_default_dialogs_shape():
    assert DEFAULT_DIALOGS["entry"] == "start"
    nodes = DEFAULT_DIALOGS["nodes"]
    assert "start" in nodes and nodes["start"]["type"] == "message"
    assert nodes["ai_reply"]["type"] == "ai"


def test_dialogs_roundtrip():
    raw = _dump_json(DEFAULT_DIALOGS)
    loaded = _load_json(raw)
    assert loaded["entry"] == "start"
    assert "ask" in loaded["nodes"]


def test_create_update_schemas():
    created = CoraxBotCreate(name="Склад", purpose="Остатки", channel="bitrix24")
    assert created.name == "Склад"
    patch = CoraxBotUpdate(ai_enabled=True, ai_model="llama3")
    assert patch.ai_enabled is True
    assert patch.ai_model == "llama3"
