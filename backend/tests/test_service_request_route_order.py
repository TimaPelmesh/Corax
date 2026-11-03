"""Ensure static ticket paths are registered before /{request_id}."""

from app.routers import service_requests


def test_request_id_route_comes_after_static_gets():
    paths: list[str] = []
    for route in service_requests.router.routes:
        methods = getattr(route, "methods", None) or set()
        path = getattr(route, "path", "") or ""
        if "GET" in methods:
            paths.append(path)

    static = [
        "/import-status",
        "/export-glpi-csv",
        "/export-pdf",
        "/templates",
    ]
    assert "/{request_id}" in paths
    request_id_at = paths.index("/{request_id}")
    for item in static:
        assert item in paths, item
        assert paths.index(item) < request_id_at, f"{item} must be registered before /{{request_id}}"
