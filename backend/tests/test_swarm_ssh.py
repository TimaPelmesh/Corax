import pytest

from app.swarm_ssh import (
    nodes_from_output,
    overview_commands,
    parse_swarm_info,
    rollback_commands,
    scale_commands,
    service_name,
    services_from_output,
)


def test_service_name_rejects_shell():
    assert service_name("web") == "web"
    assert service_name("stack_web.1") == "stack_web.1"
    with pytest.raises(ValueError):
        service_name("web;id")
    with pytest.raises(ValueError):
        service_name("web && id")
    with pytest.raises(ValueError):
        service_name("../etc")


def test_scale_command_is_one_token():
    command, _timeout = scale_commands("api", 3)[0]
    assert command == "docker service scale api=3"
    assert "sudo" not in command
    with pytest.raises(ValueError):
        scale_commands("api", 33)
    with pytest.raises(ValueError):
        scale_commands("api;reboot", 1)


def test_rollback_quotes_the_name_only():
    command, _timeout = rollback_commands("api")[0]
    assert command == "docker service rollback api"
    assert all("{{" not in item[0] or item[0].startswith("docker service ls") for item in rollback_commands("api"))


def test_overview_commands_are_fixed():
    commands = [item[0] for item in overview_commands()]
    assert commands[0].startswith("docker info ")
    assert "node ls" in commands[1]
    assert "service ls" in commands[2]
    assert not any(";" in item or "&&" in item for item in commands)


def test_parsers_read_docker_json_lines():
    state, manager = parse_swarm_info("active|true\n")
    assert state == "active"
    assert manager is True
    nodes = nodes_from_output('{"ID":"abc","Hostname":"mgr","Status":"Ready","Availability":"Active","ManagerStatus":"Leader","EngineVersion":"27.1"}\nnoise')
    assert nodes[0]["hostname"] == "mgr"
    assert nodes[0]["manager"] == "Leader"
    services = services_from_output('{"ID":"s1","Name":"api","Mode":"replicated","Replicas":"2/2","Image":"api:1","Ports":"*:80->80/tcp"}')
    assert services[0]["replicas"] == "2/2"
    assert services[0]["name"] == "api"
