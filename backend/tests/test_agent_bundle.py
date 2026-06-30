from __future__ import annotations

import io
import re
import zipfile

from app.agent_bundle import _build_win10_zip
from app.schemas import AgentBundleCreate

_STOP_JOB_FORCE = re.compile(r"Stop-Job\s+.+\s-Force\b", re.IGNORECASE)


def test_win10_bundle_is_powershell_51_compatible():
  """Web-generated ZIP must not use Stop-Job -Force (missing in Windows PowerShell 5.1)."""
  body = AgentBundleCreate(
    server_url="http://192.168.1.10:3001",
    create_token=False,
    existing_token="test-token-for-bundle",
  )
  data, name = _build_win10_zip(body, body.server_url, "test-token-for-bundle")
  assert name.startswith("corax-agent-win10-")

  with zipfile.ZipFile(io.BytesIO(data)) as zf:
    assert "agent_env.bat" in zf.namelist()
    assert "lib/Agent-Common.ps1" in zf.namelist()
    common = zf.read("lib/Agent-Common.ps1").decode("utf-8-sig")
    assert "function Stop-AgentJob" in common

    for arc_name in zf.namelist():
      if not arc_name.lower().endswith(".ps1"):
        continue
      text = zf.read(arc_name).decode("utf-8-sig")
      for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
          continue
        assert not _STOP_JOB_FORCE.search(line), f"{arc_name}: {line}"

    config = zf.read("agent_config.json").decode("utf-8")
    assert '"agent_version": "3.0.1"' in config
