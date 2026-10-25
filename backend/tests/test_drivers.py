"""Testy driverów na zanonimizowanych zrzutach z prawdziwych urządzeń UniFi."""

from __future__ import annotations

import asyncio

from conftest import FIXTURES

from netpulse.drivers import GenericDriver, LinuxDriver, UnifiDriver, detect_driver, poll_device
from netpulse.drivers.base import SystemInfo
from netpulse.drivers.linux import is_real_mount, parse_kernel
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


def test_linux_server_snmpd():
    r = poll("linux-server")
    assert r.driver == LinuxDriver.name
    s = r.system
    assert (s.kind, s.vendor, s.model, s.firmware) == ("server", "Linux", "Linux 6.8.0-45-generic", "6.8.0-45-generic")
    assert s.name == "homelab-srv" and s.uptime_s == 1234567.89
    h = r.health
    assert h.cpu_percent == 13.0 and h.mem_total_kb == 16384000
    assert h.mem_used_percent == 35.0  # bez pamięci podręcznej i buforów
    assert (h.load1, h.load5, h.load15) == (0.52, 0.40, 0.31)
    assert r.server is not None and r.server.swap_used_percent == 25.0 and r.server.processes == 213


def test_linux_server_disks_skip_pseudo_filesystems():
    disks = {d.mount: d for d in poll("linux-server").disks}
    assert set(disks) == {"/", "/boot", "/mnt/data"}  # bez /run, /dev/shm, /boot/efi, warstw Dockera i snap-ów
    assert disks["/"].total_bytes == 15_000_000 * 4096 and disks["/"].used_percent == 35.0
    assert disks["/boot"].used_percent == 25.0
    assert disks["/mnt/data"].used_percent == 89.8


def test_linux_server_hides_container_interfaces():
    r = poll("linux-server")
    assert {i.name for i in r.visible_interfaces()} == {"eno1", "wlp2s0"}
    ifs = by_name(r)
    assert ifs["eno1"].role == "lan" and ifs["eno1"].speed_mbps == 1000 and ifs["eno1"].oper_status == "up"
    assert ifs["wlp2s0"].oper_status == "down"
    for hidden in ("lo", "docker0", "br-0123456789ab", "veth1a2b3c4"):
        assert ifs[hidden].hidden
    assert ifs["docker0"].role == "virtual"


def test_linux_driver_detection_and_helpers():
    linux = SystemInfo(descr="Linux srv 6.1.0 #1 SMP x86_64", object_id="1.3.6.1.4.1.8072.3.2.10")
    assert detect_driver(linux) is LinuxDriver
    assert detect_driver(SystemInfo(descr="Cisco IOS Software")) is GenericDriver
    # Urządzenia UniFi też mają net-snmp na Linuksie, ale własny driver wygrywa
    unifi = SystemInfo(descr="Ubiquiti UniFi UCG-Ultra 5.1.33 Linux 5.4.213", object_id="1.3.6.1.4.1.8072.3.2.10")
    assert detect_driver(unifi) is UnifiDriver
    assert parse_kernel("Linux srv 6.8.0-45-generic #45 SMP") == "6.8.0-45-generic"
    assert parse_kernel("Windows") is None and parse_kernel(None) is None
    assert is_real_mount("/mnt/nas") and not is_real_mount("/run/lock") and not is_real_mount("/var/lib/docker/overlay2/x")


def test_forced_linux_driver_on_any_snmpd():
    r = poll("ucg-ultra", driver="linux")  # wymuszenie w formularzu urządzenia
    assert r.driver == "linux" and r.system.kind == "server"
