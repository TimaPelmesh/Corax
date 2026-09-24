from __future__ import annotations

from pathlib import Path


def test_dockerfile_copies_cpp_and_linux_agents():
    dockerfile = Path(__file__).resolve().parents[2] / "Dockerfile"
    text = dockerfile.read_text(encoding="utf-8")
    assert "COPY --chown=corax:corax agent/cpp ./agent/cpp" in text
    assert "COPY --chown=corax:corax agent/linux ./agent/linux" in text
    assert "agent/windows" not in text
    assert "agent/desktop" not in text
    assert "agent/win7" not in text
    assert "agent/win10" not in text
