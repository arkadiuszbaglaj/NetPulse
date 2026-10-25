"""Klient UniFi Network API i parsery na zanonimizowanych odpowiedziach z prawdziwego kontrolera."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from conftest import FIXTURES

from netpulse.unifi import UnifiApi, UnifiError, parse_clients, parse_devices
from netpulse.unifi_collector import match_devices


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_parse_devices_poe_on_switch_only():
    devices = {d.type: d for d in parse_devices(load("unifi_devices.json"))}
    assert set(devices) == {"usw", "uap", "udm"}
    sw = devices["usw"]
    assert sw.poe_max_w == 52 and sw.poe_used_w == 3.89
    assert [p.port_idx for p in sw.poe_ports] == [1, 2, 3, 4]  # porty 5–8 nie mają PoE
    p1 = sw.poe_ports[0]
    assert p1.delivering and p1.power_w == 3.89 and p1.voltage_v == 53.3 and p1.current_ma == 73 and p1.poe_mode == "auto"
    assert not sw.poe_ports[1].delivering and sw.poe_ports[1].poe_mode == "off"
    assert devices["uap"].poe_ports == [] and devices["udm"].poe_ports == []


def test_parse_clients_wifi_and_wired():
    clients = parse_clients(load("unifi_clients.json"))
    assert len(clients) == 9
    wifi = [c for c in clients if not c.is_wired]
    wired = [c for c in clients if c.is_wired]
    assert len(wifi) == 5 and len(wired) == 4
    assert all(c.signal_dbm is not None and c.essid and c.uplink_mac for c in wifi)
    assert all(c.uplink_port is not None and c.signal_dbm is None and c.essid is None for c in wired)
    assert {c.uplink_port for c in wired} == {3, 7}  # port 7 switcha = telewizor
    assert all(c.name for c in clients)  # brak nazwy w UniFi → nazwa hosta


def test_parsers_tolerate_missing_fields():
    assert parse_devices({}) == [] and parse_clients({"data": [{"name": "bez MAC"}]}) == []
    (c,) = parse_clients({"data": [{"mac": "AA:BB:CC:00:00:01", "is_wired": False}]})
    assert c.mac == "aa:bb:cc:00:00:01" and c.name is None and c.signal_dbm is None


def api_with(handler) -> UnifiApi:
    return UnifiApi("10.0.0.1", "klucz-testowy-123", transport=httpx.MockTransport(handler))


def test_api_reads_devices_clients_and_version():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-API-KEY"] == "klucz-testowy-123"
        path = request.url.path
        if path.endswith("/integration/v1/info"):
            return httpx.Response(200, json={"applicationVersion": "10.6.109"})
        if path.endswith("/api/s/default/stat/device"):
            return httpx.Response(200, json=load("unifi_devices.json"))
        if path.endswith("/api/s/default/stat/sta"):
            return httpx.Response(200, json=load("unifi_clients.json"))
        return httpx.Response(404)

    async def scenario():
        api = api_with(handler)
        try:
            assert await api.app_version() == "10.6.109"
            assert len(await api.devices()) == 3 and len(await api.clients()) == 9
        finally:
            await api.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("response", "fragment"),
    [
        (httpx.Response(401), "odrzucił klucz"),
        (httpx.Response(404), "nie zna adresu"),
        (httpx.Response(500), "kodem 500"),
        (httpx.Response(200, text="<html>"), "nie jest JSON"),
        (httpx.Response(200, json=[1, 2]), "format"),
    ],
)
def test_api_errors_have_readable_messages(response, fragment):
    async def scenario():
        api = api_with(lambda _r: response)
        try:
            with pytest.raises(UnifiError, match=fragment):
                await api.devices()
        finally:
            await api.close()

    asyncio.run(scenario())


def test_api_connection_error_is_unifi_error():
    def handler(_r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("odmowa połączenia")

    async def scenario():
        api = api_with(handler)
        try:
            with pytest.raises(UnifiError, match="Brak połączenia"):
                await api.app_version()
        finally:
            await api.close()

    asyncio.run(scenario())


def test_parse_lldp_links():
    devices = {d.type: d for d in parse_devices(load("unifi_devices.json"))}
    sw = devices["usw"]
    assert {(link.local_port_idx, link.remote_mac) for link in sw.lldp} == {
        (1, devices["uap"].mac),
        (8, devices["udm"].mac),
    }
    assert len(devices["udm"].lldp) == 2  # switch i nieznany sąsiad na porcie WAN
    assert parse_devices({"data": [{"mac": "aa:bb:cc:00:00:01", "lldp_table": [{"chassis_id": "nie-mac", "local_port_idx": 1}]}]})[0].lldp == []


def test_lldp_carries_lan_address_and_interface_macs():
    devices = {d.type: d for d in parse_devices(load("unifi_devices.json"))}
    link = next(x for x in devices["usw"].lldp if x.remote_mac == devices["udm"].mac)
    assert len(link.remote_ips) == 1 and link.remote_ips[0] != devices["udm"].ip  # adres LAN, nie `ip` z kontrolera
    assert devices["udm"].mac in devices["udm"].macs and len(devices["udm"].macs) > 1


def test_match_devices_by_ip_lan_address_then_mac():
    devices = list(parse_devices(load("unifi_devices.json")))
    by_type = {d.type: d for d in devices}
    lan = next(x for x in by_type["usw"].lldp if x.remote_mac == by_type["udm"].mac).remote_ips[0]

    # Switch i AP znamy po `ip`, bramę dopiero po adresie LAN z LLDP sąsiada
    hosts = {by_type["usw"].ip: 1, by_type["uap"].ip: 2, lan: 3}
    assert match_devices(devices, hosts, {}) == {by_type["usw"].mac: 1, by_type["uap"].mac: 2, by_type["udm"].mac: 3}

    # Bez adresu LAN ratuje adres MAC interfejsu znany z SNMP
    mac_only = match_devices(devices, {}, {by_type["udm"].macs[-1]: 7})
    assert mac_only == {by_type["udm"].mac: 7}

    assert match_devices(devices, {"10.9.9.9": 1}, {"aa:aa:aa:aa:aa:aa": 2}) == {}
