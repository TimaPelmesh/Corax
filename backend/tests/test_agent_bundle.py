from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path

from app.agent_bundle import _build_windows_zip, _build_win10_zip
from app.schemas import AgentBundleCreate, AgentBundleSchedule

_STOP_JOB_FORCE = re.compile(r"Stop-Job\s+.+\s-Force\b", re.IGNORECASE)


def test_windows_bundle_unifies_win7_and_win10():
    body = AgentBundleCreate(
        server_url="http://192.168.1.10:3000",
        create_token=False,
        existing_token="test-token-for-bundle",
        target="win10",
    )
    data, name = _build_windows_zip(body, body.server_url, "test-token-for-bundle")
    assert name.startswith("corax-agent-windows-")

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        assert "corax_send.bat" in names
        assert "agent_env.bat" in names
        assert "agent_config.json" in names
        assert "update_scripts.bat" in names
        assert "win10/corax_send.bat" in names
        assert "win10/lib/Agent-Common.ps1" in names
        assert "win7/inventory_send_win7.bat" in names
        env = zf.read("agent_env.bat").decode("utf-8")
        assert "192.168.1.10:3000" in env
        assert "__INVENTORY_SERVER__" not in env
        dispatcher = zf.read("corax_send.bat").decode("utf-8", errors="replace")
        assert "win10\\corax_send.bat" in dispatcher
        assert "Microsoft\\PowerShell\\3" in dispatcher
        assert "for /f %%P in ('powershell" not in dispatcher
        assert "CORAX_HIDDEN" in dispatcher
        assert "CORAX_VISIBLE" in dispatcher
        assert "corax_send_silent.vbs" in dispatcher
        assert "wscript.exe" in dispatcher
        assert "start \"\" wscript.exe" not in dispatcher
        assert "corax-last-run.txt" in dispatcher
        win10_bat = zf.read("win10/corax_send.bat").decode("utf-8", errors="replace")
        assert r"System32\WindowsPowerShell\v1.0\powershell.exe" in win10_bat
        assert "powershell.exe -NoProfile" not in win10_bat
        assert "WindowStyle Normal" in win10_bat
        assert "WindowStyle Hidden" in win10_bat
        assert "if defined INV_NOPAUSE" in win10_bat
        assert "if defined CORAX_HIDDEN" in win10_bat
        assert "if defined CORAX_SPLASH" not in win10_bat
        assert "start /wait" not in win10_bat.lower()
        common = zf.read("win10/lib/Agent-Common.ps1").decode("utf-8-sig")
        assert "function Stop-AgentJob" in common
        assert "function Write-CoraxLastRun" in common
        assert "corax-last-run.txt" in common
        for arc_name in names:
            if not arc_name.lower().endswith(".ps1"):
                continue
            text = zf.read(arc_name).decode("utf-8-sig")
            for line in text.splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                assert not _STOP_JOB_FORCE.search(line), f"{arc_name}: {line}"
        config = zf.read("agent_config.json").decode("utf-8")
        assert "3.2.3-windows" in config
        client = zf.read("win10/InventoryClient.ps1").decode("utf-8-sig")
        assert "Start-ExtendedCollectJob" not in client
        assert "Invoke-ExtendedInProcess" in client
        core_post = client.find("$exitCode = Send-InventoryReport")
        ext_call = client.find("$extra = Invoke-ExtendedInProcess")
        assert core_post != -1 and ext_call != -1
        assert core_post < ext_call
        first_shortcut = client.find("Install-CoraxHelpdeskShortcut")
        assert first_shortcut != -1
        assert first_shortcut < core_post
        assert "/h#pc=" in common
        assert "Оставить заявку.url" in common
        assert "CORAX-ticket" in common
        assert "/r#" not in common
        assert "WScript.Shell" in common
        assert "OneDrive" in common
        splash = zf.read("win10/corax_splash.ps1").decode("utf-8-sig")
        assert "SetCursorPosition" not in splash
        assert "CursorVisible" not in splash
        win7_bat = zf.read("win7/inventory_send_win7.bat").decode("utf-8", errors="replace")
        assert "if defined CORAX_SPLASH" not in win7_bat
        assert "WindowStyle Hidden" in win7_bat
        assert "if defined INV_NOPAUSE" in win7_bat
        win7_client = zf.read("win7/InventoryClient_win7.ps1").decode("utf-8-sig")
        assert "/h#pc=" in win7_client
        assert "Оставить заявку.url" in win7_client
        assert "CORAX-ticket.url" in win7_client
        post = zf.read("win10/lib/Invoke-Post.ps1").decode("utf-8-sig")
        assert "ConvertTo-AgentJson" in post
        assert "JavaScriptSerializer" in post
        run_cmd = (
            Path(__file__).resolve().parents[2]
            / "agent"
            / "cpp"
            / "portable"
            / "corax_run.cmd"
        ).read_text(encoding="utf-8", errors="replace")
        assert "Install-HelpdeskShortcut.ps1" not in run_cmd
        assert not any(ln.strip().lower().startswith("start ") for ln in run_cmd.splitlines())
        assert "pause" in run_cmd.lower()
        main_cpp = (
            Path(__file__).resolve().parents[2] / "agent" / "cpp" / "src" / "main.cpp"
        ).read_text(encoding="utf-8", errors="replace")
        assert "FreeConsole()" not in main_cpp
        fail_upload = main_cpp.find("ERROR: upload failed")
        shortcut_ok = main_cpp.find("ensure_helpdesk_shortcut")
        assert fail_upload != -1 and shortcut_ok != -1
        assert shortcut_ok > fail_upload


def test_win10_target_alias_builds_unified_zip():
    body = AgentBundleCreate(
        server_url="http://192.168.1.10:3000",
        create_token=False,
        existing_token="test-token-for-bundle",
    )
    data, name = _build_win10_zip(body, body.server_url, "test-token-for-bundle")
    assert name.startswith("corax-agent-windows-")
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        assert "win7/inventory_send_win7.bat" in zf.namelist()
        assert "corax_send_silent.vbs" in zf.namelist()
        silent = zf.read("corax_send_silent.vbs").decode("utf-8", errors="replace")
        assert "WindowStyle 0" in silent or ", 0, True" in silent
        assert "nopause" in silent
        assert "CORAX_HIDDEN" in silent
        assert "hidden" in silent
        assert "/r#" not in silent


def test_windows_bundle_schedule_runs_hidden_as_system():
    body = AgentBundleCreate(
        server_url="http://192.168.1.10:3000",
        create_token=False,
        existing_token="test-token-for-bundle",
        target="win10",
        schedule=AgentBundleSchedule(enabled=True, mode="WEEKLY", time="09:00", task_name="CORAX-Agent"),
    )
    data, _name = _build_windows_zip(body, body.server_url, "test-token-for-bundle")
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        assert "install_schedule.bat" in names
        assert "corax_send_silent.vbs" in names
        bat = zf.read("install_schedule.bat").decode("utf-8", errors="replace")
        tr_line = next(ln for ln in bat.splitlines() if "/TR" in ln)
        assert "wscript.exe" in tr_line
        assert "corax_send.bat" not in tr_line
        assert "cmd.exe" not in tr_line
        assert "/RU SYSTEM" in bat
        assert "/NP" in bat
        assert "/Run" in bat
        assert "corax-last-run.txt" in bat
        ps = zf.read("register_scheduled_task.ps1").decode("utf-8-sig", errors="replace")
        assert "wscript.exe" in ps
        assert "/RU" in ps and "SYSTEM" in ps
        assert "cmd.exe /c" not in ps
        assert "/Run" in ps
        assert "corax-last-run.txt" in ps


def test_dockerfile_copies_windows_agent_wrapper():
    """Panel ZIP looks at /app/agent/windows — image must include the dispatcher tree."""
    from pathlib import Path

    dockerfile = Path(__file__).resolve().parents[2] / "Dockerfile"
    text = dockerfile.read_text(encoding="utf-8")
    assert "agent/windows" in text
    assert "COPY --chown=corax:corax agent/windows ./agent/windows" in text
    assert "COPY --chown=corax:corax agent/desktop/prebuilt ./agent/desktop/prebuilt" in text


def test_desktop_bundle_seals_token_and_omits_plaintext(tmp_path):
    import json

    from app.agent_desktop import empty_seal_slot, pack_desktop_zip, seal_agent_token, stamp_desktop_exe

    fake = tmp_path / "CORAX-Agent.exe"

    slot = empty_seal_slot()
    fake.write_bytes(b"MZ" + slot + b"\0" * 60_000)
    secret = "aabbccdd.super-secret-token-value"
    data = pack_desktop_zip(fake, secret)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        assert set(names) == {"CORAX-Agent.exe", "agent.json", "Install.bat", "README.txt"}
        exe = zf.read("CORAX-Agent.exe")
        assert secret.encode("utf-8") not in exe
        assert b"<<<CORAX_DESKTOP_SEAL_BEGIN>>>" in exe
        raw = zf.read("agent.json").decode("utf-8")
        assert secret not in raw
        cfg = json.loads(raw)
        assert "token_enc" in cfg
        assert cfg["token_prefix"] == "aabbccdd"
        assert cfg["token_enc"]["wrap"].encode("ascii") in exe
        assert "token" not in cfg
        from app.agent_desktop import unseal_agent_token

        assert unseal_agent_token(cfg["token_enc"]) == secret
        assert cfg["daily_at"] == "09:00"
        assert cfg["autostart"] is True
        bat = zf.read("Install.bat").decode("utf-8")
        assert "CurrentVersion\\Run" in bat
        readme = zf.read("README.txt").decode("utf-8")
        assert "прототип" not in readme.lower()
        assert "Windows 10/11" in readme
        sealed = seal_agent_token("x")
        assert sealed["v"] == 1
        decoy = b"MZ" + b"<<<CORAX_DESKTOP_SEAL_BEGIN>>>" + (b"Q" * 8000) + b"<<<CORAX_DESKTOP_SEAL_END>>>" + slot
        stamped = stamp_desktop_exe(decoy + b"\0" * 1000, sealed)
        assert sealed["wrap"].encode("ascii") in stamped
        assert stamped[len(b"MZ") + len(b"<<<CORAX_DESKTOP_SEAL_BEGIN>>>") :].startswith(b"Q")
