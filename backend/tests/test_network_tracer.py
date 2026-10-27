from __future__ import annotations

import ipaddress

from app.network_tracer import collect_trace_target_ips, parse_trace_output


def test_parse_windows_tracert_numeric_hops():
    output = """
Tracing route to 10.20.0.25 over a maximum of 10 hops

  1    <1 ms    <1 ms    <1 ms  192.168.1.1
  2     4 ms     *        5 ms  10.20.0.1
  3    11 ms    12 ms    10 ms  10.20.0.25
"""
    hops = parse_trace_output(output, "10.20.0.25")
    assert [hop.ip for hop in hops] == ["192.168.1.1", "10.20.0.1", "10.20.0.25"]
    assert hops[0].rtt_ms == 1.0
    assert hops[-1].rtt_ms == 11.0


def test_parse_linux_traceroute_deduplicates_and_ignores_timeouts():
    output = """
traceroute to 10.30.0.8 (10.30.0.8), 10 hops max
 1  192.168.1.1  0.482 ms
 2  * * *
 3  10.30.0.1  5.125 ms
 4  10.30.0.1  5.221 ms
 5  10.30.0.8  8.950 ms
"""
    hops = parse_trace_output(output, "10.30.0.8")
    assert [hop.ip for hop in hops] == ["192.168.1.1", "10.30.0.1", "10.30.0.8"]
    assert hops[1].rtt_ms == 5.125


def test_parse_trace_ignores_loopback_hops():
    output = """
 1  127.0.0.1  0.100 ms
 2  8.8.8.8  4.000 ms
 3  10.0.0.1  1.500 ms
"""
    hops = parse_trace_output(output, "10.0.0.1")
    assert [hop.ip for hop in hops] == ["10.0.0.1"]


def test_collect_trace_targets_covers_neighbor_gateways():
    local = [ipaddress.ip_network("192.168.1.0/24")]
    targets = collect_trace_target_ips(
        [("192.168.1.10", "switch", "snmp")],
        neighbor_networks=["10.20.0.0/24", "10.30.0.0/24"],
        gateway_ips=["192.168.1.1"],
        computer_ips=["10.20.0.55"],
        local_networks=local,
        max_targets=48,
    )
    assert "192.168.1.1" in targets
    assert "192.168.1.10" in targets
    assert "10.20.0.1" in targets
    assert "10.30.0.1" in targets
    assert targets.index("10.20.0.1") < targets.index("192.168.1.10")


def test_collect_trace_targets_prefers_router_on_same_subnet():
    targets = collect_trace_target_ips(
        [
            ("10.0.0.50", "host", "snmp"),
            ("10.0.0.1", "router", "snmp"),
        ],
        local_networks=[ipaddress.ip_network("10.0.0.0/24")],
        max_targets=8,
    )
    assert targets[0] == "10.0.0.1"
