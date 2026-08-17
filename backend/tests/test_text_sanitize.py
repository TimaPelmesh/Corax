from __future__ import annotations

from app.text_sanitize import deep_strip_nul, like_contains, strip_nul_text


def test_strip_nul_text():
    assert strip_nul_text(None) is None
    assert strip_nul_text("hello") == "hello"
    assert strip_nul_text("Roblox\u0000") == "Roblox"
    assert strip_nul_text("\x00\x00") is None


def test_deep_strip_nul():
    raw = {"software": [{"name": "A\u0000B", "version": "1\u0000"}]}
    cleaned = deep_strip_nul(raw)
    assert cleaned["software"][0]["name"] == "AB"
    assert cleaned["software"][0]["version"] == "1"


def test_like_contains_escapes_wildcards():
    assert like_contains("pc-01") == "%pc-01%"
    assert like_contains("  100%  ") == r"%100\%%"
    assert like_contains("a_b") == r"%a\_b%"
    assert like_contains("a\\b") == r"%a\\b%"
    assert like_contains("\x00win") == "%win%"
    assert like_contains("   ") == "%%"


def test_strip_nul_text():
    assert strip_nul_text(None) is None
    assert strip_nul_text("hello") == "hello"
    assert strip_nul_text("Roblox\u0000") == "Roblox"
    assert strip_nul_text("\x00\x00") is None


def test_deep_strip_nul():
    raw = {"software": [{"name": "A\u0000B", "version": "1\u0000"}]}
    cleaned = deep_strip_nul(raw)
    assert cleaned["software"][0]["name"] == "AB"
    assert cleaned["software"][0]["version"] == "1"
