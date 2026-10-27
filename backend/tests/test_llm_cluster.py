"""llama.cpp metrics, the LLM allowlist, the operator role, and the control audit."""

from __future__ import annotations

import importlib.util
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from starlette.testclient import TestClient

from app.llm_access import can_manage_llm, can_view_llm, is_llm_operator, llm_operator_path_allowed
from app.llm_metrics import build_health, derive_layers, parse_llamacpp_metrics, service_url
from app.server_audit_jobs import explain_job


class _User:
    def __init__(self, role: str, *, superuser: bool = False) -> None:
        self.role = role
        self.is_superuser = superuser
        self.is_active = True


def test_parse_llamacpp_metrics_sums_totals_and_keeps_speed():
    text = """
# HELP llamacpp:prompt_tokens_seconds Prompt throughput
llamacpp:prompt_tokens_seconds 120.5
llamacpp:predicted_tokens_seconds 42
llamacpp:tokens_predicted_total 10
llamacpp:prompt_tokens_total 3
llamacpp:tokens_predicted_total{slot="1"} 4
llamacpp:prompt_tokens_seconds_sum 999
"""
    parsed = parse_llamacpp_metrics(text)
    assert parsed["prompt_tokens_seconds"] == 120.5
    assert parsed["predicted_tokens_seconds"] == 42.0
    assert parsed["tokens_predicted_total"] == 14.0
    assert parsed["prompt_tokens_total"] == 3.0
    assert "prompt_tokens_seconds_sum" not in parsed


def test_parse_llamacpp_underscore_names():
    parsed = parse_llamacpp_metrics("llamacpp_predicted_tokens_seconds 7\n")
    assert parsed == {"predicted_tokens_seconds": 7.0}


def test_allowlist_rejects_shell_and_foreign_units():
    assert explain_job("restart", "nginx", None) is None
    assert explain_job("restart", "nginx;id", None) is not None
    assert explain_job("restart", "bash", None) is not None
    assert explain_job("start", "llama-server", None) is None
    assert explain_job("start", "llama-server;reboot", None) is not None
    assert explain_job("start", "nginx", None) is not None
    assert explain_job("stop", "rpc-server-gpu1", None) is None
    assert explain_job("journal", "rpc-server-gpu0", "40") is None
    assert explain_job("journal", "nginx", "40") is not None
    assert explain_job("journal", "llama-server", "id") is not None
    assert explain_job("restart", "llama-server", None) is None
    assert explain_job("restart", "llama-server", "--metric") is not None
    bad_model = json.dumps({"model": "/etc/passwd"})
    assert explain_job("llama-apply", "llama-server", bad_model) is not None
    injected = json.dumps({"model": "/models/a.gguf", "command": "id"})
    assert explain_job("llama-apply", "llama-server", injected) is not None
    ok = json.dumps({"model": "/models/a.gguf", "ngl": 32, "metrics": True, "flash_attn": True, "rpc": "worker:50052"})
    assert explain_job("llama-apply", "llama-server", ok) is None
    assert explain_job("models", "/etc", None) is not None
    assert explain_job("models", "/models", None) is None
    assert explain_job("rpc-probe", "rpc", json.dumps({"ports": [50052, 50053]})) is None
    assert explain_job("rpc-probe", "rpc", json.dumps({"ports": [22]})) is not None


def test_agent_execute_rejects_the_same_unsafe_jobs():
    path = Path(__file__).resolve().parents[2] / "agent" / "linux" / "lib" / "run_jobs.py"
    spec = importlib.util.spec_from_file_location("corax_run_jobs_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.execute({"action": "start", "target": "nginx"})[0] == 1
    assert module.execute({"action": "journal", "target": "nginx", "body": "40"})[0] == 1
    assert module.execute({"action": "restart", "target": "llama-server;id"})[0] == 1
    assert module.execute({"action": "restart", "target": "bash"})[0] == 1
    assert module.execute(
        {"action": "llama-apply", "target": "llama-server", "body": json.dumps({"model": "/tmp/x.gguf"})}
    )[0] == 1
    assert module.execute({"action": "models", "target": "/"})[0] == 1
    assert module.execute({"action": "rpc-probe", "target": "ssh"})[0] == 1


def test_layer_counts_are_labeled_by_source():
    measured = derive_layers("llm_load_tensors: offloaded 32/40 layers to GPU\n", None)
    assert measured["source"] == "journal"
    assert measured["local_layers"] == 32
    assert measured["remote_layers"] == 8
    assert measured["total_layers"] == 40
    requested = derive_layers("", {"ngl": 20})
    assert requested["source"] == "config"
    assert requested["local_layers"] == 20
    assert requested["remote_layers"] is None
    assert derive_layers("", None)["source"] == "unknown"


def test_health_document_shape():
    empty = build_health([], datetime.now(timezone.utc))
    assert empty["status"] == "down"
    assert set(empty) >= {"status", "checked_at", "llama", "rpc"}
    assert set(empty["llama"]) >= {"configured", "reachable", "metrics_age_sec", "model", "detail"}
    fresh = build_health(
        [
            {
                "role": "central",
                "hostname": "gpu0",
                "metrics_configured": True,
                "metrics_ok": True,
                "metrics_age_sec": 5,
                "model": "model.gguf",
                "rpc": [
                    {
                        "unit": "rpc-server-gpu0",
                        "port": 50052,
                        "listening": True,
                        "active": True,
                        "vram_total_mb": 24576,
                        "vram_used_mb": 1024,
                    }
                ],
            }
        ]
    )
    assert fresh["status"] == "ok"
    assert fresh["llama"]["reachable"] is True
    assert fresh["llama"]["model"] == "model.gguf"
    assert fresh["rpc"][0]["port"] == 50052
    assert fresh["rpc"][0]["vram_total_mb"] == 24576
    stale = build_health(
        [
            {
                "role": "central",
                "hostname": "gpu0",
                "metrics_configured": True,
                "metrics_ok": False,
                "metrics_age_sec": 600,
                "model": None,
                "rpc": [],
            }
        ]
    )
    assert stale["status"] == "degraded"
    assert stale["llama"]["reachable"] is False


def test_metrics_url_must_be_the_node():
    assert service_url("http://gpu01:8080/metrics", hostname="gpu01", ip="10.0.0.5", kind="metrics")
    assert service_url("http://10.0.0.5:8080", hostname="gpu01", ip="10.0.0.5", kind="metrics")
    assert service_url("http://127.0.0.1:8080/metrics", hostname="gpu01", ip="10.0.0.5", kind="metrics") is None
    assert service_url("http://evil.example/metrics", hostname="gpu01", ip="10.0.0.5", kind="metrics") is None
    assert service_url("http://169.254.169.254/latest", hostname="169.254.169.254", ip=None, kind="metrics") is None


def test_llm_operator_role_boundaries():
    operator = _User("llm-operator")
    observer = _User("observer")
    editor = _User("editor")
    assert is_llm_operator(operator)
    assert can_view_llm(operator) and can_manage_llm(operator)
    assert can_view_llm(observer) and not can_manage_llm(observer)
    assert can_manage_llm(editor)
    assert not is_llm_operator(_User("llm-operator", superuser=True))
    assert llm_operator_path_allowed("GET", "/api/v1/llm/health")
    assert llm_operator_path_allowed("POST", "/api/v1/llm/chat")
    assert llm_operator_path_allowed("GET", "/api/v1/auth/me")
    assert llm_operator_path_allowed("POST", "/api/v1/users/me/change-password")
    assert not llm_operator_path_allowed("GET", "/api/v1/computers")
    assert not llm_operator_path_allowed("GET", "/api/v1/users")
    assert llm_operator_path_allowed("GET", "/api/v1/server-audit/hosts")
    assert llm_operator_path_allowed("POST", "/api/v1/server-audit/hosts/1/ssh")
    assert not llm_operator_path_allowed("POST", "/api/v1/server-audit/hosts/1/jobs")
    assert not llm_operator_path_allowed("DELETE", "/api/v1/server-audit/hosts/1")


def test_health_endpoint_audit_log_and_operator_scope(client: TestClient, auth_headers: dict[str, str]):
    health = client.get("/api/v1/llm/health", headers=auth_headers)
    assert health.status_code == 200
    payload = health.json()
    assert payload["status"] in {"ok", "degraded", "down"}
    assert "configured" in payload["llama"]
    assert isinstance(payload["rpc"], list)

    hostname = "llm" + uuid.uuid4().hex[:10]
    created_host = client.post(
        "/api/v1/server-audit/hosts",
        headers=auth_headers,
        json={"hostname": hostname, "interval_seconds": 900, "enabled": True},
    )
    assert created_host.status_code == 200, created_host.text
    host_id = created_host.json()["id"]
    created_node = client.post(
        "/api/v1/llm/nodes",
        headers=auth_headers,
        json={
            "host_id": host_id,
            "role": "central",
            "metrics_url": f"http://{hostname}:8080/metrics",
            "rpc_ports": "50052,50053",
            "model_dir": "/models",
        },
    )
    assert created_node.status_code == 200, created_node.text
    node_id = created_node.json()["id"]

    refused = client.post(
        f"/api/v1/llm/nodes/{node_id}/jobs",
        headers=auth_headers,
        json={"action": "start", "target": "nginx"},
    )
    assert refused.status_code == 400
    shell = client.post(
        f"/api/v1/server-audit/hosts/{host_id}/jobs",
        headers=auth_headers,
        json={"action": "restart", "target": "nginx;id"},
    )
    assert shell.status_code == 400

    queued = client.post(
        f"/api/v1/llm/nodes/{node_id}/jobs",
        headers=auth_headers,
        json={"action": "journal", "target": "llama-server", "body": "40"},
    )
    assert queued.status_code == 200, queued.text
    audit = client.get("/api/v1/llm/audit", headers=auth_headers)
    assert audit.status_code == 200
    assert any(row["action"] == "journal" and row["job_id"] == queued.json()["id"] for row in audit.json())

    name = "llmop" + uuid.uuid4().hex[:8]
    created_user = client.post(
        "/api/v1/users",
        headers=auth_headers,
        json={"username": name, "password": "llm-operator-pass", "role": "llm-operator", "is_superuser": False},
    )
    assert created_user.status_code == 200, created_user.text
    assert created_user.json()["role"] == "llm-operator"
    login = client.post(
        "/api/v1/auth/login/json",
        json={"username": name, "password": "llm-operator-pass", "return_token": True},
    )
    assert login.status_code == 200, login.text
    operator_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert client.get("/api/v1/computers", headers=operator_headers).status_code == 403
    assert client.get("/api/v1/server-audit/hosts", headers=operator_headers).status_code == 403
    seen = client.get("/api/v1/llm/health", headers=operator_headers)
    assert seen.status_code == 200
    assert "llama" in seen.json() and "rpc" in seen.json()
    client.post(f"/api/v1/users/{created_user.json()['id']}/delete", headers=auth_headers)
