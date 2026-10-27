import pytest

from app.server_audit_jobs import explain_job, ssh_admin_command


def test_restart_allows_nginx_and_refuses_a_shell():
    assert explain_job("restart", "nginx", None) is None
    assert explain_job("restart", "nginx.service", None) is None
    assert explain_job("restart", "nginx;id", None) is not None
    assert explain_job("restart", "systemd", None) is not None
    assert explain_job("status", "cron", None) is None
    assert explain_job("restart", "my-worker", None) is None
    assert explain_job("units", "service", None) is None
    assert explain_job("show", "nginx", None) is None
    assert explain_job("show", "bash", None) is not None


def test_paths_stay_inside_config_dirs():
    assert explain_job("read", "/etc/nginx/nginx.conf", None) is None
    assert explain_job("read", "/etc/shadow", None) is not None
    assert explain_job("read", "/etc/nginx/../../etc/shadow", None) is not None
    assert explain_job("read", "/etc/ssh/sshd_config", None) is None
    assert explain_job("write", "/etc/nginx/conf.d/site.conf", "server {}\n") is None
    assert explain_job("write", "/etc/nginx/nginx.conf", "nope") is not None
    assert explain_job("write", "/etc/sudoers.d/x", "x") is not None
    assert explain_job("write", "/etc/cron.d/x", "x") is not None
    assert explain_job("write", "/etc/nginx/conf.d/tls.key", "x") is not None
    assert explain_job("test", "sshd", None) is None
    assert explain_job("test", "bash", None) is not None


def test_ssh_admin_command_stays_on_the_list():
    logs, _timeout = ssh_admin_command("logs", "llama-server", 80)
    assert logs.startswith("journalctl -u ")
    assert "llama-server" in logs
    assert ";" not in logs
    gpu, _gpu_timeout = ssh_admin_command("gpu", "", 20)
    assert gpu == "nvidia-smi"
    with pytest.raises(ValueError):
        ssh_admin_command("logs", "nginx;id", 80)
    custom, _custom_timeout = ssh_admin_command("restart", "my-worker", 20)
    assert custom == "systemctl restart my-worker"
    with pytest.raises(ValueError):
        ssh_admin_command("restart", "bash", 20)
    with pytest.raises(ValueError):
        ssh_admin_command("restart", "systemd", 20)
    with pytest.raises(ValueError):
        ssh_admin_command("sh", "llama-server", 20)
