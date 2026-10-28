from __future__ import annotations

import importlib.util
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_sampler_does_not_wait_on_a_stuck_command():
    module = _load("corax_collect_hang", ROOT / "agent" / "linux" / "lib" / "collect_audit.py")
    started = time.monotonic()
    text = module._run([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.4)
    assert text == ""
    assert time.monotonic() - started < 4


def test_link_speed_is_not_read_in_this_process():
    module = _load("corax_collect_speed", ROOT / "agent" / "linux" / "lib" / "collect_audit.py")
    assert module._read_slow("/etc/passwd") == ""
    assert module._read_slow("/sys/class/net/eth0/../../etc/passwd") == ""


def test_restarting_the_sampler_does_not_wait_for_itself(monkeypatch):
    module = _load("corax_jobs_hang", ROOT / "agent" / "linux" / "lib" / "run_jobs.py")
    captured: dict = {}

    class _Proc:
        returncode = 0

        def communicate(self, timeout=None):
            return "", ""

        def kill(self):
            return None

    def popen(argv, **_kwargs):
        captured["argv"] = list(argv)
        return _Proc()

    monkeypatch.setattr(subprocess, "Popen", popen)
    code, _text = module._run(["systemctl", "restart", "corax-audit"], timeout=5)
    assert code == 0
    idx = captured["argv"].index("systemctl")
    assert captured["argv"][idx + 1 : idx + 4] == ["--no-block", "restart", "corax-audit"]
    module._run(["systemctl", "restart", "nginx"], timeout=5)
    idx = captured["argv"].index("systemctl")
    assert captured["argv"][idx + 1] == "restart"
    assert "--no-block" not in captured["argv"]


def test_loop_detaches_from_the_ssh_session():
    audit = (ROOT / "agent" / "linux" / "audit_agent.sh").read_text(encoding="utf-8")
    common = (ROOT / "agent" / "linux" / "lib" / "common.sh").read_text(encoding="utf-8")
    assert "exec </dev/null" in audit
    assert "export CORAX_AUDIT_INSIDE_LOOP=1" in audit
    assert "CORAX_AUDIT_INSIDE_LOOP=1 timeout" in audit
    assert "systemd-notify WATCHDOG=1" in audit
    assert "WatchdogSec=420" in common
    assert "StandardInput=null" in common
    assert "restart_audit_service" in common
