from __future__ import annotations

from app.html_sanitize import sanitize_html
from app.net_trust import client_ip_from_parts, llm_url_allowed
from helpers import sample_inventory, unique_hostname
from starlette.testclient import TestClient


def test_health_v1_does_not_leak_lan_ips(client: TestClient):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "lan_ip" not in body
    assert "lan_ips" not in body


def test_untrusted_xff_is_ignored():
    assert client_ip_from_parts("10.0.0.8", "192.168.3.50", None, trust_forwarded=False) == "10.0.0.8"
    assert client_ip_from_parts("172.18.0.1", "192.168.3.50", None, trust_forwarded=True) == "192.168.3.50"


def test_public_llm_url_denied_by_default():
    assert llm_url_allowed("http://127.0.0.1:11434/v1") is True
    assert llm_url_allowed("http://169.254.169.254/latest/meta-data") is False
    assert llm_url_allowed("https://api.openai.com/v1") is False


def test_notes_html_strips_script():
    cleaned = sanitize_html('<p>ok</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>')
    assert "script" not in cleaned.lower()
    assert "javascript:" not in cleaned.lower()
    assert "ok" in cleaned


def test_notes_html_keeps_toolbar_span_styles_and_comments():
    cleaned = sanitize_html(
        '<p><span style="font-weight:700">жирный</span>'
        '<!-- комментарий --><span style="font-style:italic">курсив</span></p>'
    )
    assert "жирный" in cleaned
    assert "курсив" in cleaned
    assert "комментарий" in cleaned
    assert "<strong>" in cleaned
    assert "<em>" in cleaned
    assert "script" not in cleaned.lower()


def test_ticket_handler_unknown_host_rejected(client: TestClient):
    r = client.get("/api/v1/ticket-handler/public/context", params={"hostname": "no-such-pc-xyz"})
    assert r.status_code == 403


def test_ticket_handler_sso_header_ignored_without_proxy(client: TestClient, agent_headers: dict[str, str]):
    hn = unique_hostname("sso-pc")
    posted = client.post("/api/v1/agent/inventory", json=sample_inventory(hn), headers=agent_headers)
    assert posted.status_code == 200
    ctx = client.get(
        "/api/v1/ticket-handler/public/context",
        params={"hostname": hn},
        headers={"Remote-User": "attacker"},
    )
    assert ctx.status_code == 200
    hint = str(ctx.json().get("requester_hint") or "").lower()
    assert "attacker" not in hint


def test_agent_rejects_hostname_mac_takeover(client: TestClient, agent_headers: dict[str, str]):
    hn = unique_hostname("bind-pc")
    body = sample_inventory(hn)
    created = client.post("/api/v1/agent/inventory", json=body, headers=agent_headers)
    assert created.status_code == 200
    body["mac_primary"] = "AA:BB:CC:DD:EE:FF"
    body["serial_number"] = "OTHER-SN"
    hijack = client.post("/api/v1/agent/inventory", json=body, headers=agent_headers)
    assert hijack.status_code == 403
