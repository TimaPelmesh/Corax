from app.network_snmp_vendors import (
    extra_walk_oids_for,
    merge_neighbors,
    parse_generic_cache,
    parse_mikrotik_mndp,
    parse_qbridge_fdb,
    OID_MTXR_NEIGH_IP,
)


def test_parse_mikrotik_mndp_neighbor():
    neighbors = parse_mikrotik_mndp(
        ip_map={"1": bytes((10, 0, 0, 2))},
        mac_map={"1": bytes((0x4C, 0x5E, 0x0C, 0x11, 0x22, 0x33))},
        ident_map={"1": "core-sw"},
        plat_map={"1": "CRS326-24G-2S+"},
        if_map={"1": "ether1"},
        if_by_index={"1": {"name": "ether1", "descr": "uplink"}},
    )
    assert len(neighbors) == 1
    n = neighbors[0]
    assert n["protocol"] == "mndp"
    assert n["remote_name"] == "core-sw"
    assert n["remote_ip"] == "10.0.0.2"
    assert n["remote_chassis"] == "4c:5e:0c:11:22:33"
    assert n["local_port"] == "ether1"


def test_parse_h3c_ndp_and_fdp():
    ndp = parse_generic_cache(
        protocol="ndp",
        id_map={"10": "SW-CORE"},
        port_map={"10": "GigabitEthernet1/0/1"},
        addr_map={"10": "192.168.1.1"},
        plat_map={"10": "HPE 5510"},
    )
    assert ndp[0]["protocol"] == "ndp"
    assert ndp[0]["remote_name"] == "SW-CORE"
    assert ndp[0]["remote_ip"] == "192.168.1.1"

    fdp = parse_generic_cache(
        protocol="fdp",
        id_map={"2": "icx-leaf"},
        port_map={"2": "1/1/1"},
        addr_map={"2": bytes((10, 20, 30, 1))},
    )
    assert fdp[0]["protocol"] == "fdp"
    assert fdp[0]["remote_ip"] == "10.20.30.1"


def test_qbridge_fdb_vlan_mac_index():
    # vlan 10 + MAC aa:bb:cc:dd:ee:ff
    key = "10.170.187.204.221.238.255"
    rows = parse_qbridge_fdb({key: 24})
    assert rows[0]["mac"] == "aa:bb:cc:dd:ee:ff"
    assert rows[0]["port"] == "24"


def test_merge_neighbors_dedupes_same_remote():
    a = {"protocol": "lldp", "remote_ip": "10.0.0.1", "remote_name": "sw", "local_if_index": "1"}
    b = {"protocol": "lldp", "remote_ip": "10.0.0.1", "remote_name": "sw", "local_if_index": "1"}
    c = {"protocol": "cdp", "remote_ip": "10.0.0.1", "remote_name": "sw", "local_if_index": "1"}
    merged = merge_neighbors([a, b], [c])
    assert len(merged) == 2
    protocols = {n["protocol"] for n in merged}
    assert protocols == {"lldp", "cdp"}


def test_mikrotik_oid_selects_mndp_walks():
    oids = extra_walk_oids_for("1.3.6.1.4.1.14988.1", "MikroTik", neighbor_count=0)
    assert OID_MTXR_NEIGH_IP in oids


def test_cisco_with_lldp_skips_mndp_walks():
    oids = extra_walk_oids_for("1.3.6.1.4.1.9.1.1745", "Cisco", neighbor_count=4)
    assert OID_MTXR_NEIGH_IP not in oids
