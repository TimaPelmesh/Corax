"""Tests for CORAX agent EXE builder."""

from __future__ import annotations

import sys

import pytest

from app.agent_exe import _write_embedded, exe_build_available


def test_exe_build_available_non_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    ok, reason = exe_build_available()
    assert ok is False
    assert reason


def test_write_embedded(tmp_path):
    _write_embedded(tmp_path, "http://192.168.1.5:3001", "abc.secret")
    text = (tmp_path / "corax_embedded.py").read_text(encoding="utf-8")
    assert 'SERVER = "http://192.168.1.5:3001"' in text
    assert 'TOKEN = "abc.secret"' in text
