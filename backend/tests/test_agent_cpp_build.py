from __future__ import annotations

import pytest

from app.agent_cpp_build import patch_config_slot


def test_patch_config_slot_injects_json():
    begin = b"<<<CORAX_CFG_BEGIN>>>"
    end = b"<<<CORAX_CFG_END>>>"
    # Short decoy (like C-string literals) + real padded slot
    decoy = begin + b"{}" + end
    middle = b"{}" + (b" " * 200)
    fake = b"MZ...." + decoy + b"...." + begin + middle + end + b"...tail"
    out = patch_config_slot(fake, '{"server_url":"http://x:3000","agent_token":"t"}')
    chunk = out[out.find(begin, out.find(decoy) + 1) + len(begin) : out.rfind(end)]
    assert b"http://x:3000" in chunk
    assert b'"agent_token":"t"' in chunk


def test_patch_config_slot_rejects_oversized():
    begin = b"<<<CORAX_CFG_BEGIN>>>"
    end = b"<<<CORAX_CFG_END>>>"
    fake = b"x" + begin + (b" " * 80) + end + b"y"
    with pytest.raises(ValueError, match="слишком большой"):
        patch_config_slot(fake, "{" + ("a" * 200) + "}")


def test_patch_config_slot_missing_markers():
    with pytest.raises(ValueError, match="слот"):
        patch_config_slot(b"no markers here", "{}")


def test_patch_config_slot_rejects_tiny_slot():
    begin = b"<<<CORAX_CFG_BEGIN>>>"
    end = b"<<<CORAX_CFG_END>>>"
    fake = begin + b"{}" + end
    with pytest.raises(ValueError, match="слишком мал"):
        patch_config_slot(fake, "{}")
