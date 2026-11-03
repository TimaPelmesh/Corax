"""AI role inheritance and purpose validation."""

import pytest

from app.ai_agents import AI_PURPOSES, purpose_ok


def test_purposes_cover_chat_embed_tickets_bitrix():
    assert AI_PURPOSES == ("chat", "embed", "tickets", "bitrix_bot")
    assert purpose_ok("Chat") == "chat"
    with pytest.raises(ValueError):
        purpose_ok("vision")
