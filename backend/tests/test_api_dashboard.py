from __future__ import annotations

from helpers import sample_inventory, unique_hostname
from starlette.testclient import TestClient


def test_dashboard_summary(client: TestClient, auth_headers: dict[str, str], agent_headers: dict[str, str]):
    hn = unique_hostname("dash")
    client.post("/api/v1/agent/inventory", json=sample_inventory(hn), headers=agent_headers)

    badges = client.get("/api/v1/dashboard/nav-badges", headers=auth_headers)
    assert badges.status_code == 200
    badge_body = badges.json()
    for key in (
        "computers_total",
        "software_unique_titles",
        "service_requests_active",
        "snmp_printers_total",
        "notes_total",
    ):
        assert key in badge_body
        assert isinstance(badge_body[key], int)
    assert "by_os" not in badge_body
    assert "ram_buckets" not in badge_body

    r = client.get("/api/v1/dashboard/summary", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    for key in (
        "computers_total",
        "computers_online",
        "computers_offline",
        "service_requests_on_time_pct",
        "by_os",
        "ram_buckets",
        "by_manufacturer",
        "physical_disks_by_media",
        "peripheral_kinds",
    ):
        assert key in body
    assert isinstance(body["computers_online"], int)
    assert isinstance(body["computers_offline"], int)
    assert body["service_requests_on_time_pct"] is None or isinstance(body["service_requests_on_time_pct"], int)
    assert "upcoming_notes" in body
    assert isinstance(body["upcoming_notes"], list)
    assert "notes_total" in body
    assert isinstance(body["notes_total"], int)
    assert body["notes_total"] >= 0
    assert "service_requests_closed_series" in body
    assert isinstance(body["service_requests_closed_series"], list)
    assert body.get("service_requests_closed_granularity") in ("day", "week", "month")
    assert any(row["name"] == "Google Chrome" and row["count"] >= 1 for row in body.get("browsers") or [])
    assert any(row["name"] == "Microsoft Office" and row["count"] >= 1 for row in body.get("office_suites") or [])

    cached = client.get("/api/v1/dashboard/summary", headers=auth_headers)
    assert cached.status_code == 200
    assert cached.json()["computers_total"] == body["computers_total"]

    catalog = client.get(
        "/api/v1/dashboard/software-catalog",
        headers=auth_headers,
        params={"q": "Chrome", "limit": 5},
    )
    assert catalog.status_code == 200, catalog.text
    chrome_rows = [row for row in catalog.json() if "Chrome" in str(row.get("name", ""))]
    assert chrome_rows
    assert chrome_rows[0]["count"] >= 1

    wildcard = client.get(
        "/api/v1/dashboard/catalog",
        headers=auth_headers,
        params={"kind": "software", "q": "100%", "limit": 5},
    )
    assert wildcard.status_code == 200, wildcard.text

    name = catalog.json()[0]["name"]
    hosts = client.get(
        "/api/v1/dashboard/software-hosts",
        headers=auth_headers,
        params={"name": name},
    )
    assert hosts.status_code == 200
    assert "hostnames" in hosts.json()

    seg = client.get(
        "/api/v1/dashboard/segment-computers",
        headers=auth_headers,
        params={"kind": "os", "name": "Windows 10 Pro", "chart_title": "ОС"},
    )
    assert seg.status_code == 200
    assert seg.json()["total"] >= 1
    assert any(hn in str(row.get("hostname", "")) for row in seg.json()["items"])

    chrome = client.get(
        "/api/v1/dashboard/segment-computers",
        headers=auth_headers,
        params={"kind": "software_family", "name": "Google Chrome", "chart_title": "Браузеры"},
    )
    assert chrome.status_code == 200, chrome.text
    assert chrome.json()["total"] >= 1
    assert chrome.json()["items"]

    office = client.get(
        "/api/v1/dashboard/segment-computers",
        headers=auth_headers,
        params={"kind": "software_family", "name": "Microsoft Office"},
    )
    assert office.status_code == 200, office.text
    assert office.json()["total"] >= 1
    assert office.json()["items"]

    empty_seg = client.get(
        "/api/v1/dashboard/segment-computers",
        headers=auth_headers,
        params={"kind": "os", "name": "NoSuchOS-xyz"},
    )
    assert empty_seg.status_code == 200
    assert empty_seg.json()["items"] == []
    assert empty_seg.json()["total"] == 0

    bad_kind = client.get(
        "/api/v1/dashboard/segment-computers",
        headers=auth_headers,
        params={"kind": "nope", "name": "x"},
    )
    assert bad_kind.status_code == 422

    pcs = client.get("/api/v1/computers", headers=auth_headers, params={"q": hn})
    pc_id = pcs.json()["items"][0]["id"]
    client.delete(f"/api/v1/computers/{pc_id}", headers=auth_headers)


def test_dashboard_calendar_includes_plans_and_open_scheduled_requests(
    client: TestClient,
    auth_headers: dict[str, str],
):
    plan = client.post(
        "/api/v1/notes",
        headers=auth_headers,
        json={
            "title": "Dashboard calendar plan",
            "plan_start": "2031-05-29",
            "plan_end": "2031-06-03",
        },
    )
    assert plan.status_code == 200, plan.text

    open_request = client.post(
        "/api/v1/service-requests",
        headers=auth_headers,
        json={
            "title": "Dashboard calendar open ticket",
            "status": "open",
            "planned_close_at": "2031-06-15T10:00:00Z",
        },
    )
    assert open_request.status_code == 200, open_request.text

    closed_request = client.post(
        "/api/v1/service-requests",
        headers=auth_headers,
        json={
            "title": "Dashboard calendar closed ticket",
            "status": "done",
            "planned_close_at": "2031-06-16T10:00:00Z",
        },
    )
    assert closed_request.status_code == 200, closed_request.text

    response = client.get("/api/v1/dashboard/calendar?month=2031-06-01", headers=auth_headers)
    assert response.status_code == 200, response.text
    items = response.json()
    plan_row = next(item for item in items if item["kind"] == "plan" and item["id"] == plan.json()["id"])
    assert plan_row["title"] == "Dashboard calendar plan"
    assert plan_row["start_date"] == "2031-06-01"
    assert plan_row["end_date"] == "2031-06-03"
    assert "color" in plan_row
    assert "mark" in plan_row
    assert any(
        item["id"] == open_request.json()["id"]
        and item["kind"] == "request"
        and item["start_date"] == "2031-06-15"
        for item in items
    )
    assert not any(item["id"] == closed_request.json()["id"] for item in items)
