"""Mapa sieci: który interfejs SNMP odpowiada numerowi portu z kontrolera (obciążenie kabla, 0.35.0)."""

from __future__ import annotations

from netpulse.api.topology import port_interface
from netpulse.db.models import Interface


def iface(name: str) -> Interface:
    return Interface(device_id=1, if_index=0, name=name)


def test_switch_ports_by_unifi_name():
    ports = [iface("0/1"), iface("0/8"), iface("eth0")]
    assert port_interface(ports, 8).name == "0/8"
    assert port_interface(ports, 1).name == "0/1"  # „0/1” ma pierwszeństwo przed eth0


def test_gateway_and_ap_ports_by_eth():
    ports = [iface("eth0"), iface("eth4"), iface("br0")]
    assert port_interface(ports, 5).name == "eth4"  # WAN UCG Ultra
    assert port_interface(ports, 1).name == "eth0"  # uplink AP


def test_unknown_port():
    assert port_interface([iface("eth0")], 3) is None
    assert port_interface([iface("eth0")], None) is None
