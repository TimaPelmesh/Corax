from types import SimpleNamespace

from app.ticket_client_identity import client_ip_from_parts, is_dockerish_ip, sam_account
from app.ticket_handler_runtime import (
    assignee_public_label,
    hostname_candidates,
    normalize_intake_status,
    requester_label_for_user,
    summarize_public_assignees,
)


def test_hostname_candidates_fqdn_and_netbios():
    assert hostname_candidates("PC-023.corp.local") == ["pc-023.corp.local", "pc-023"]
    assert hostname_candidates("CORP\\PC-023$") == ["corp\\pc-023$", "pc-023$", "pc-023"]
    assert hostname_candidates("  PC-023.  ") == ["pc-023"]
    assert hostname_candidates("") == []


def test_requester_label_matches_directory_picker():
    user = SimpleNamespace(full_name="Иван Петров", username="ivanov")
    assert requester_label_for_user(user) == "Иван Петров (ivanov)"  # type: ignore[arg-type]
    only_login = SimpleNamespace(full_name="", username="ivanov")
    assert requester_label_for_user(only_login) == "ivanov"  # type: ignore[arg-type]


def test_client_ip_prefers_forwarded_lan_only_from_trusted_proxy():
    assert client_ip_from_parts("172.17.0.1", "192.168.3.50, 172.17.0.1", None, trust_forwarded=False) == "172.17.0.1"
    assert client_ip_from_parts("172.17.0.1", "192.168.3.50, 172.17.0.1", None, trust_forwarded=True) == "192.168.3.50"
    assert client_ip_from_parts("::ffff:10.1.2.3", None, None) == "10.1.2.3"


def test_dockerish_and_sam_account():
    assert is_dockerish_ip("172.17.0.1")
    assert not is_dockerish_ip("192.168.3.50")
    assert sam_account(r"CORP\ivanov") == "ivanov"
    assert sam_account("ivanov@corp.local") == "ivanov"


def test_intake_status_starts_open():
    assert normalize_intake_status(None) == "open"
    assert normalize_intake_status("new") == "open"
    assert normalize_intake_status("open") == "open"
    assert normalize_intake_status("in_progress") == "open"
    assert normalize_intake_status("done") == "done"


def test_public_assignee_labels():
    assert assignee_public_label("Иван Петров", "ipetrov") == "Иван Петров"
    assert assignee_public_label("", "ipetrov") == "ipetrov"
    assert assignee_public_label(None, "ticket-handler-bot") is None
    assert summarize_public_assignees(["Анна", "Борис"]) == ["Анна", "Борис"]
    assert summarize_public_assignees(["Анна", "Борис", "Виктор"]) == ["IT-поддержка"]
