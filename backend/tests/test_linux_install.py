from __future__ import annotations

import ast

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
