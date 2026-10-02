from app.desktop_client import patch_utf16_config_slot


def test_utf16_slot_accepts_server_url():
    begin = "<<<CORAX_CFG_BEGIN>>>".encode("utf-16le")
    end = "<<<CORAX_CFG_END>>>".encode("utf-16le")
    gap = ("{}" + (" " * 128)).encode("utf-16le")
    blob = b"prefix" + begin + gap + end + b"suffix"
    patched = patch_utf16_config_slot(blob, {"server_url": "http://10.0.0.5:3000"})
    text = patched.decode("utf-16le", errors="ignore")
    assert "http://10.0.0.5:3000" in text
    assert patched.startswith(b"prefix")
    assert patched.endswith(b"suffix")
