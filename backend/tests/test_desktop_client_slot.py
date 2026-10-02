from app.desktop_client import patch_utf16_config_slot, stamp_config_trailer


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


def test_trailer_carries_server_url_and_replaces_itself():
    stamped = stamp_config_trailer(b"MZ-exe", {"server_url": "http://10.0.0.5:3000"})
    assert stamped.startswith(b"MZ-exe")
    assert stamped.endswith(b"CORAXCFG")
    again = stamp_config_trailer(stamped, {"server_url": "https://corax.lan:3000"})
    assert again.startswith(b"MZ-exe")
    assert b"https://corax.lan:3000" in again
    assert b"http://10.0.0.5:3000" not in again
