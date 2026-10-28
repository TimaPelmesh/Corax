from app.windows_install import (
    agent_launch_command,
    assert_lan_host,
    claim_windows_exe,
    explain_remote_failure,
    remote_script,
    split_account,
    stage_windows_exe,
)


class _StatusError(Exception):
    def __init__(self, code: int):
        super().__init__("session")
        self.error = code

    def getErrorCode(self):
        return self.error


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


def test_smb_starts_only_the_agent():
    assert split_account(r"CORP\admin") == ("CORP", "admin")
    assert split_account("admin@corp.local") == ("corp.local", "admin")
    command = agent_launch_command()
    assert command == r'"C:\ProgramData\CORAX\Agent\CORAX-Agent.exe" --install --silent'
    assert "cmd" not in command.lower()


def test_open_port_is_not_blamed_for_a_rejected_login():
    text = explain_remote_failure(_StatusError(0xC000006D), "login")
    assert "учётка не вошла" in text
    assert "445 и 135" not in text


def test_copy_denial_says_the_share_not_the_port():
    text = explain_remote_failure(_StatusError(0xC0000022), "copy")
    assert "C$" in text
    assert "закрыт" not in text
    assert "445 и 135" not in text


def test_start_failure_does_not_claim_the_share_failed():
    text = explain_remote_failure(TimeoutError("timed out"), "start")
    assert "уже скопирован" in text
    assert "445 и 135" not in text


def test_refused_port_is_named_only_when_the_socket_refused():
    text = explain_remote_failure(ConnectionRefusedError(111, "Connection refused"), "connect")
    assert "445" in text
    assert "отказал" in text


def test_staged_exe_can_be_claimed_once():
    stage_windows_exe("once.token", b"MZ")
    assert claim_windows_exe("once.token") == b"MZ"
    assert claim_windows_exe("once.token") is None
