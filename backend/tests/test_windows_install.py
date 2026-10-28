from app.windows_install import (
    agent_launch_command,
    assert_lan_host,
    claim_windows_exe,
    copy_targets,
    explain_remote_failure,
    replace_commands,
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
    share, remote, local, cwd = copy_targets()[0]
    assert (share, remote, cwd) == ("ADMIN$", r"Temp\CORAX-Agent.exe", r"C:\Windows\Temp")
    dropped = agent_launch_command(local)
    assert dropped == r'"C:\Windows\Temp\CORAX-Agent.exe" --install --silent'
    assert "cmd" not in dropped.lower()
    setup = agent_launch_command(r"C:\Windows\Temp\CORAX-Agent-setup.exe")
    assert setup == r'"C:\Windows\Temp\CORAX-Agent-setup.exe" --install --silent'
    assert "cmd" not in setup.lower()
    prelude = replace_commands()
    assert prelude[-1] == r"C:\Windows\System32\taskkill.exe /F /IM CORAX-Agent.exe"
    assert all("cmd" not in command.lower() for command in prelude)
    assert all(command.startswith("C:\\Windows\\System32\\") for command in prelude)


def test_open_port_is_not_blamed_for_a_rejected_login():
    text = explain_remote_failure(_StatusError(0xC000006D), "login")
    assert "учётка не вошла" in text
    assert "445 и 135" not in text


def test_copy_denial_says_the_share_not_the_port():
    text = explain_remote_failure(_StatusError(0xC0000022), "copy")
    assert "локального администратора" in text
    assert "Dr.Web" in text
    assert "закрыт" not in text
    assert "445 и 135" not in text


def test_sharing_violation_means_the_file_is_open():
    text = explain_remote_failure(_StatusError(0xC0000043), "copy")
    assert "открыт" in text
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
