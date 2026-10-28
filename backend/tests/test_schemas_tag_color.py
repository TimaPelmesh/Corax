"""Pure tag color validation from app.schemas (no DB)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import TagCreate, TagUpdate, normalize_tag_color


def test_normalize_tag_color_accepts_hex_and_lowercases():
    assert normalize_tag_color("#AABBCC") == "#aabbcc"
    assert normalize_tag_color("  #00ff00  ") == "#00ff00"


def test_normalize_tag_color_treats_blank_as_none():
    assert normalize_tag_color(None) is None
    assert normalize_tag_color("") is None
    assert normalize_tag_color("   ") is None


@pytest.mark.parametrize(
    "raw",
    ["red", "#fff", "#GG0000", "#12345", "aabbcc", "#1234567"],
)
def test_normalize_tag_color_rejects_invalid(raw: str):
    with pytest.raises(ValueError, match="Цвет"):
        normalize_tag_color(raw)


def test_tag_create_validator_normalizes_color():
    tag = TagCreate(name="lab", color="#FF00AA")
    assert tag.color == "#ff00aa"


def test_tag_create_blank_color_becomes_none():
    assert TagCreate(name="lab", color="").color is None
    assert TagCreate(name="lab", color=None).color is None


def test_tag_create_rejects_bad_color():
    with pytest.raises(ValidationError):
        TagCreate(name="lab", color="blue")


def test_tag_update_color_patch_rules():
    assert TagUpdate(color="#ABCDEF").color == "#abcdef"
    assert TagUpdate(name="x").color is None
    with pytest.raises(ValidationError):
        TagUpdate(color="#12")
