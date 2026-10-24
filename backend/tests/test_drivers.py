"""Testy driverów na zanonimizowanych zrzutach z prawdziwych urządzeń UniFi."""

from __future__ import annotations

import asyncio

from conftest import FIXTURES

from netpulse.drivers import UnifiDriver, poll_device
from netpulse.snmp.snmprec import SnmprecClient


def poll(name: str, driver: str = "auto"):
    client = SnmprecClient.from_file(FIXTURES / f"{name}.snmprec")
    return asyncio.run(poll_device(client, driver))


def by_name(result):
    return {i.name: i for i in result.interfaces}


def test_ucg_ultra_gateway():
    r = poll("ucg-ultra")
    assert r.driver == UnifiDriver.name
    assert r.system.kind == "gateway"
    assert r.system.model == "UCG-Ultra"
    assert r.system.firmware == "5.1.33"
    ifs = by_name(r)
    assert (ifs["eth4"].role, ifs["eth4"].label) == ("wan", "WAN")
    assert [ifs[f"eth{n}"].label for n in range(4)] == ["LAN 1", "LAN 2", "LAN 3", "LAN 4"]
    visible = {i.name for i in r.visible_interfaces()}
    assert visible == {"eth0", "eth1", "eth2", "eth3", "eth4"}
    assert ifs["eth4"].counter_bits == 64
    assert ifs["eth4"].in_octets and ifs["eth4"].in_octets > 0
    assert ifs["eth4"].speed_mbps == 1000
    assert r.health.mem_total_kb and r.health.mem_used_percent is not None
    assert r.health.load1 is not None


def test_usw_lite_switch():
    r = poll("usw-lite-8-poe")
    assert r.system.kind == "switch"
    ports = r.visible_interfaces()
    assert [p.label for p in ports] == [f"Port {n}" for n in range(1, 9)]
    ifs = by_name(r)
    assert ifs["0/1"].alias == "AP U6+"
    assert ifs["0/8"].alias == "UCG Ultra"
    assert ifs["0/2"].alias is None  # domyślny alias "Port 2" jest pomijany
    assert ifs["0/7"].speed_mbps == 100  # telewizor
    assert ifs["0/2"].oper_status == "down"


def test_u6_plus_access_point():
    r = poll("u6-plus")
    assert r.system.kind == "ap"
    assert r.system.model == "U6+"
    assert r.system.firmware == "6.7.54.15663"
    visible = r.visible_interfaces()
    assert [(i.name, i.role) for i in visible] == [("eth0", "uplink")]
    ssids = [w for w in r.wifi if not w.hidden]
    assert {(w.ssid, w.radio) for w in ssids} == {
        ("NetPulse-Test-2G", "2.4GHz"),
        ("NetPulse-Test", "2.4GHz"),
        ("NetPulse-Test", "5GHz"),
    }
    assert sum(w.clients or 0 for w in ssids) == 5
    assert all(w.hidden for w in r.wifi if w.ssid.startswith(("element-", "vwire-")))


def test_generic_driver_forced():
    r = poll("usw-lite-8-poe", driver="generic")
    assert r.driver == "generic"
    assert len(r.interfaces) == 8
    assert r.interfaces[0].label == "AP U6+"  # generic: alias jako etykieta
