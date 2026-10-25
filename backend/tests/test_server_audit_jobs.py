from app.server_audit_jobs import explain_job


def test_restart_allows_nginx_and_refuses_a_shell():
    assert explain_job("restart", "nginx", None) is None
    assert explain_job("restart", "nginx.service", None) is None
    assert explain_job("restart", "nginx;id", None) is not None
    assert explain_job("restart", "systemd", None) is not None
    assert explain_job("status", "cron", None) is None


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
