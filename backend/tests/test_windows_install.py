from app.windows_install import (
    assert_lan_host,
    claim_windows_exe,
    remote_script,
    stage_windows_exe,
)


def test_lan_host_rejects_public_and_loopback():
    assert assert_lan_host("192.168.1.20") == "192.168.1.20"
    assert assert_lan_host("10.1.2.3") == "10.1.2.3"
    for blocked in ("8.8.8.8", "127.0.0.1", "169.254.1.1", "1.2.3.4"):
        try:
            assert_lan_host(blocked)
        except ValueError:
            continue
        raise AssertionError(blocked)


def test_remote_script_is_a_hidden_install():
    script = remote_script("http://192.168.1.10:3000", "abcd1234.token-value")
    assert "--install" in script
    assert "--silent" in script
    assert "WindowStyle Hidden" in script
    assert "http://192.168.1.10:3000/api/v1/agent/windows-installer" in script


def test_staged_exe_can_be_claimed_once():
    stage_windows_exe("once.token", b"MZ")
    assert claim_windows_exe("once.token") == b"MZ"
    assert claim_windows_exe("once.token") is None
