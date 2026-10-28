from __future__ import annotations

import ast
import time

import pytest

from app.linux_install import clean_ssh_host, installer_source, one_command


def test_one_command_and_installer_are_closed():
    cmd = one_command("http://10.1.1.8:3000", "abcd1234.secret_token", 15)
    assert cmd.startswith("sudo python3 -c '")
    assert cmd.endswith("'")
    assert "Bearer abcd1234.secret_token" in cmd
    assert "interval=15" in cmd
    src = installer_source("http://10.1.1.8:3000", "abcd1234.secret_token", 15)
    ast.parse(src)
    assert "/opt/corax-agent" in src
    assert "CORAX_AUDIT_INTERVAL" in src
    assert "abcd1234.secret_token" in src
    assert ".." in src


def test_ssh_host_rejects_shell():
    with pytest.raises(ValueError):
        clean_ssh_host("10.0.0.1;id")
    with pytest.raises(ValueError):
        clean_ssh_host("host name")
    assert clean_ssh_host("llm-central-noda") == "llm-central-noda"


class _Channel:
    def __init__(self, chunks: list[bytes], hang: bool = False):
        self.chunks = list(chunks)
        self.hang = hang
        self.exit_ready = False
        self.closed = False

    def settimeout(self, _seconds: float) -> None:
        return None

    def recv_ready(self) -> bool:
        # The bug: a PTY can hold bytes while this stays false.
        return False

    def recv(self, _size: int) -> bytes:
        if self.hang:
            raise TimeoutError()
        if not self.chunks:
            self.exit_ready = True
            return b""
        item = self.chunks.pop(0)
        if item == b"":
            self.exit_ready = True
        return item

    def exit_status_ready(self) -> bool:
        return self.exit_ready

    def recv_exit_status(self) -> int:
        return 0

    def close(self) -> None:
        self.closed = True


class _Stdout:
    def __init__(self, channel: _Channel):
        self.channel = channel


def test_ssh_collect_reads_when_recv_ready_lies():
    from app.linux_install import _collect

    channel = _Channel([b"corax-agent: scripts unpacked\n", b"corax-agent: setup exit 0\n", b""])
    started = time.monotonic()
    code, text = _collect(_Stdout(channel), 5)
    assert time.monotonic() - started < 1.5
    assert code == 0
    assert "scripts unpacked" in text
    assert "setup exit 0" in text


def test_ssh_collect_stops_when_the_channel_never_exits():
    from app.linux_install import InstallError, _collect

    channel = _Channel([], hang=True)
    started = time.monotonic()
    with pytest.raises(InstallError):
        _collect(_Stdout(channel), 0.6)
    assert time.monotonic() - started < 2.5
    assert channel.closed

