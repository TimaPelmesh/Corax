"""The Windows agent binary the panel is willing to hand to already installed trays."""

from __future__ import annotations

import hashlib
from pathlib import Path

_cache: dict[str, object] = {"key": None, "sha256": "", "size": 0}


def release_meta() -> dict:
    """Version and hash of the template EXE shipped in this container.

    The hash is of the unstamped template. Each PC copies its own server
    address and token into that file locally, so the token is not reissued.
    """
    from app.agent_cpp_build import AGENT_RELEASE_VERSION, _resolve_prebuilt_template

    path = _resolve_prebuilt_template()
    if path is None:
        return {"version": AGENT_RELEASE_VERSION, "sha256": "", "size": 0, "path": None}
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size)
    if _cache.get("key") != key:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        _cache["key"] = key
        _cache["sha256"] = digest
        _cache["size"] = st.st_size
    return {
        "version": AGENT_RELEASE_VERSION,
        "sha256": str(_cache["sha256"]),
        "size": int(_cache["size"]),
        "path": path,
    }


def release_file() -> Path | None:
    path = release_meta().get("path")
    return path if isinstance(path, Path) else None
