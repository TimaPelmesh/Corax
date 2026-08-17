import json
from datetime import datetime, timedelta, timezone

from starlette.testclient import TestClient

from app.models import Computer, DiskVolume
from app.risk_engine import antivirus_posture, evaluate_computer


def _computer(**overrides) -> Computer:
    values = {
        "id": 7,
        "hostname": "WS-RISK-07",
        "os_name": "Windows 11 Pro",
        "last_report_at": datetime.now(timezone.utc),
        "memory_used_percent": 40,
        "raw_payload": json.dumps(
            {
                "extended": {
                    "antivirus": [{"display_name": "Microsoft Defender"}],
                    "bitlocker": [{"mount_point": "C:", "protected": True}],
                    "tpm": {"present": True, "enabled": True},
                    "physical_disks": [{"friendly_name": "NVMe", "health_status": "0"}],
                    "modules_result": {
                        "antivirus": {"status": "ok"},
                        "bitlocker": {"status": "ok"},
                    },
                }
            }
        ),
    }
    values.update(overrides)
    return Computer(**values)


def test_healthy_computer_has_no_findings():
    findings = evaluate_computer(
        _computer(),
        volumes=[DiskVolume(id=1, computer_id=7, mount="C:", used_percent=45)],
        overdue_tickets=0,
        now=datetime.now(timezone.utc),
    )
    assert findings == []


def test_security_and_capacity_rules_are_deterministic():
    computer = _computer(
        os_name="Windows 10 Pro",
        memory_used_percent=97,
        raw_payload=json.dumps(
            {
                "extended": {
                    "antivirus": [],
                    "bitlocker": [{"mount_point": "C:", "protected": False}],
                    "tpm": {"present": False},
                    "modules_result": {
                        "antivirus": {"status": "degraded"},
                        "bitlocker": {"status": "ok"},
                    },
                }
            }
        ),
    )
    findings = evaluate_computer(
        computer,
        volumes=[DiskVolume(id=2, computer_id=7, mount="C:", used_percent=96)],
        overdue_tickets=2,
        now=datetime.now(timezone.utc),
    )
    ids = {item.id for item in findings}
    assert "7:os-eol-win10" in ids
    assert "7:antivirus-missing" in ids
    assert "7:bitlocker-system" in ids
    assert "7:tpm-missing" in ids
    assert "7:volume-critical-2" in ids
    assert "7:memory-pressure" in ids
    assert "7:tickets-overdue" in ids


def test_skipped_antivirus_does_not_create_false_alarm():
    computer = _computer(
        raw_payload=json.dumps(
            {
                "extended": {
                    "antivirus": [],
                    "modules_result": {"antivirus": {"status": "skipped"}},
                }
            }
        ),
        last_report_at=datetime.now(timezone.utc) - timedelta(days=8),
    )
    findings = evaluate_computer(
        computer,
        volumes=[],
        overdue_tickets=0,
        now=datetime.now(timezone.utc),
    )
    ids = {item.id for item in findings}
    assert "7:antivirus-missing" not in ids
    assert "7:agent-stale" in ids


def test_powershell_bitlocker_status_on_is_treated_as_protected():
    computer = _computer(
        raw_payload=json.dumps(
            {
                "extended": {
                    "bitlocker": [{"mount_point": "C:", "protection_status": "On"}],
                    "secure_boot_enabled": False,
                    "pending_reboot": True,
                    "modules_result": {"bitlocker": {"status": "ok"}},
                }
            }
        )
    )
    findings = evaluate_computer(
        computer,
        volumes=[],
        overdue_tickets=0,
        now=datetime.now(timezone.utc),
    )
    ids = {item.id for item in findings}
    assert "7:bitlocker-system" not in ids
    assert "7:secure-boot-disabled" in ids
    assert "7:pending-reboot" in ids


def test_antivirus_posture_decodes_security_center_and_software_fallback():
    active = _computer(
        raw_payload=json.dumps(
            {
                "extended": {
                    "antivirus": [
                        {"display_name": "Microsoft Defender", "product_state": "397568"}
                    ],
                    "modules_result": {"antivirus": {"status": "ok"}},
                }
            }
        )
    )
    disabled = _computer(
        raw_payload=json.dumps(
            {
                "extended": {
                    "antivirus": [
                        {"display_name": "Microsoft Defender", "product_state": "393472"}
                    ],
                    "modules_result": {"antivirus": {"status": "ok"}},
                }
            }
        )
    )
    unknown = _computer(raw_payload=json.dumps({"extended": {"modules_result": {}}}))

    assert antivirus_posture(active) == ("protected", "security-center")
    assert antivirus_posture(disabled) == ("attention", "disabled")
    assert antivirus_posture(unknown, security_software=["Dr.Web Security Space"]) == (
        "protected",
        "software-fallback",
    )
    assert antivirus_posture(unknown) == ("unknown", "not-collected")


def test_risk_overview_requires_authentication(client: TestClient):
    client.cookies.clear()
    response = client.get("/api/v1/risks/overview")
    assert response.status_code == 401


def test_risk_overview_contract(client: TestClient, auth_headers: dict[str, str]):
    response = client.get("/api/v1/risks/overview", headers=auth_headers)
    assert response.status_code == 200
    body = response.json()
    assert 0 <= body["fleet_health_score"] <= 100
    assert body["computers_total"] >= 0
    assert (
        body["antivirus_protected"]
        + body["antivirus_attention"]
        + body["antivirus_unknown"]
        == body["computers_total"]
    )
    assert isinstance(body["categories"], list)
    assert isinstance(body["computers"], list)
    assert isinstance(body["findings"], list)
    assert "findings_open" in body
    assert "findings_acknowledged" in body
    assert "findings_ignored" in body


def test_risk_history_and_finding_actions(
    client: TestClient,
    auth_headers: dict[str, str],
    agent_headers: dict[str, str],
):
    from helpers import sample_inventory, unique_hostname

    hostname = unique_hostname("risk-hist")
    posted = client.post("/api/v1/agent/inventory", json=sample_inventory(hostname), headers=agent_headers)
    assert posted.status_code == 200, posted.text

    overview = client.get("/api/v1/risks/overview", headers=auth_headers)
    assert overview.status_code == 200, overview.text
    body = overview.json()
    findings = body["findings"]
    assert isinstance(findings, list)

    history = client.get("/api/v1/risks/history", headers=auth_headers)
    assert history.status_code == 200, history.text
    assert isinstance(history.json()["items"], list)
    assert len(history.json()["items"]) >= 1

    target = next((item for item in findings if item.get("hostname") == hostname), None)
    if target is None and findings:
        target = findings[0]
    if target is None:
        return

    finding_id = target["id"]
    acked = client.post(
        "/api/v1/risks/findings/actions",
        headers=auth_headers,
        json={"finding_id": finding_id, "status": "acknowledged"},
    )
    assert acked.status_code == 200, acked.text
    assert acked.json()["status"] == "acknowledged"

    after = client.get("/api/v1/risks/overview", headers=auth_headers)
    assert after.status_code == 200
    after_body = after.json()
    after_finding = next((item for item in after_body["findings"] if item["id"] == finding_id), None)
    assert after_finding is not None
    assert after_finding["status"] == "acknowledged"
    assert int(after_body["findings_acknowledged"]) >= 1
    computer_after = next((item for item in after_body["computers"] if item["id"] == target["computer_id"]), None)
    if computer_after is not None:
        assert all(item["id"] != finding_id for item in computer_after["top_findings"])

    reopened = client.post(
        "/api/v1/risks/findings/actions",
        headers=auth_headers,
        json={"finding_id": finding_id, "status": "open"},
    )
    assert reopened.status_code == 200
    assert reopened.json()["status"] == "open"
