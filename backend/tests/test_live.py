"""Dane na żywo dla wykresów kołowych: wspólne odpytywanie urządzeń i WebSocket (bez bazy – lista portów podstawiona)."""

from __future__ import annotations

import asyncio

import pytest
from conftest import FIXTURES
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from netpulse.api import app
from netpulse.api.live import LiveHub, LivePort, LiveTarget
from netpulse.collector import DeviceTarget
from netpulse.snmp import SnmpCredentials
from netpulse.snmp import oids as O
from netpulse.snmp.snmprec import SnmprecClient

PORT_IN = f"{O.IF_HC_IN_OCTETS}.8"
PORT_OUT = f"{O.IF_HC_OUT_OCTETS}.9"
TARGET = DeviceTarget(1, "ucg", "10.0.0.1", 161, "auto", SnmpCredentials(version="2c", community="public"))


def make_hub(**kw) -> tuple[LiveHub, SnmprecClient]:
    client = SnmprecClient.from_file(FIXTURES / "ucg-ultra.snmprec")
    hub = LiveHub(client_factory=lambda _t: client, interval=0.2, **kw)
    loaded: list[frozenset[int]] = []

    async def targets(device_ids):
        loaded.append(device_ids)
        return [LiveTarget(TARGET, (LivePort(80, 8, 1000), LivePort(90, 9, 1000)))] if 1 in device_ids else []

    hub._load_targets = targets  # type: ignore[method-assign]
    hub.loaded = loaded  # type: ignore[attr-defined]
    return hub, client


async def until_rates(q, wanted: dict[int, str]) -> dict[int, float]:
    """Czeka, aż każdy port z `wanted` (id → klucz) dostanie niezerową prędkość; zwraca te prędkości."""
    seen: dict[int, float] = {}
    while len(seen) < len(wanted):
        msg = await asyncio.wait_for(q.get(), 5)
        for p in msg["ports"]:
            if p["id"] in wanted and p[wanted[p["id"]]]:
                seen[p["id"]] = p[wanted[p["id"]]]
    return seen


def test_rates_of_watched_device_ports():
    async def scenario():
        hub, client = make_hub()
        q = hub.subscribe(1)
        first = await asyncio.wait_for(q.get(), 5)
        assert [p["id"] for p in first["ports"]] == [80, 90]
        assert first["ports"][0]["in_bps"] is None  # pierwszy odczyt nie ma z czym porównać
        # Stan portu, CPU i RAM tym samym driverem co w kolektorze (UCD-SNMP-MIB); router nie ma dysków
        assert first["ports"][0]["up"] == 1.0
        assert first["cpu_percent"] is not None and 0 < first["mem_used_percent"] < 100
        assert "disks" not in first
        assert hub.loaded[-1] == frozenset({1})
        for oid, delta in ((PORT_IN, 1_000_000), (PORT_OUT, 500_000)):
            client.set(oid, (await client.get([oid]))[oid] + delta)
        rates = await until_rates(q, {80: "in_bps", 90: "out_bps"})
        assert 0 < rates[80] <= 1_000_000 * 8 / 0.1  # 1 MB w jednym–dwóch odstępach, rząd wielkości zgodny
        assert rates[90] > 0
        await hub.unsubscribe(q)
        assert hub._task is None and hub.viewers == 0

    asyncio.run(scenario())


def test_linux_server_disks_and_port_down():
    client = SnmprecClient.from_file(FIXTURES / "linux-server.snmprec")
    hub = LiveHub(client_factory=lambda _t: client, interval=0.2)

    async def targets(device_ids):
        return [LiveTarget(TARGET, (), "linux")]

    hub._load_targets = targets  # type: ignore[method-assign]

    async def scenario():
        q = hub.subscribe(1)
        msg = await asyncio.wait_for(q.get(), 5)
        await hub.unsubscribe(q)
        return msg

    msg = asyncio.run(scenario())
    assert msg["ports"] == [] and msg["cpu_percent"] is not None
    assert msg["disks"] and all(d["total_bytes"] == d["used_bytes"] + d["free_bytes"] for d in msg["disks"])
    assert "/" in {d["mount"] for d in msg["disks"]}


def test_unreachable_device_sends_empty_values():
    class Down(SnmprecClient):
        async def get(self, oids):
            raise TimeoutError

    hub = LiveHub(client_factory=lambda _t: Down({}), interval=0.2)

    async def targets(device_ids):
        return [LiveTarget(TARGET, (LivePort(80, 8, 1000),))]

    hub._load_targets = targets  # type: ignore[method-assign]

    async def scenario():
        q = hub.subscribe(1)
        msg = await asyncio.wait_for(q.get(), 5)
        await hub.unsubscribe(q)
        return msg

    msg = asyncio.run(scenario())
    assert msg["cpu_percent"] is None and msg["ports"] == [{"id": 80, "in_bps": None, "out_bps": None, "up": None}]


def test_device_without_ports_gets_empty_samples():
    async def scenario():
        hub, _ = make_hub()
        q = hub.subscribe(7)
        msg = await asyncio.wait_for(q.get(), 5)
        assert msg["ports"] == []
        await hub.unsubscribe(q)

    asyncio.run(scenario())


def test_viewer_limit_and_shared_polling():
    async def scenario():
        hub, _ = make_hub(max_viewers=2)
        a, b = hub.subscribe(1), hub.subscribe(1)
        assert a is not None and b is not None
        assert hub.subscribe(1) is None
        task = hub._task
        await hub.unsubscribe(a)
        assert hub._task is task  # drugi widz nadal korzysta z tego samego odpytywania
        await hub.unsubscribe(b)
        assert hub._task is None

    asyncio.run(scenario())


def test_websocket_requires_device_and_login():
    for path in ("/api/live/device", "/api/live/device?device=x", "/api/live/device?device=1"):
        with pytest.raises(WebSocketDisconnect), TestClient(app).websocket_connect(path):
            pass


def test_old_streams_are_gone():
    for path in ("/api/live/wan", "/api/live/ports?device=1"):
        with pytest.raises(WebSocketDisconnect), TestClient(app).websocket_connect(path):
            pass


def test_websocket_rejects_foreign_origin():
    headers = {"origin": "http://obca-strona.example"}
    with pytest.raises(WebSocketDisconnect), TestClient(app).websocket_connect("/api/live/device?device=1", headers=headers):
        pass


# --- VPN na żywo (0.72.0) -----------------------------------------------------------------------


class FakeVpnApi:
    def __init__(self, raw=None, fail=False):
        self.raw, self.fail, self.closed, self.calls = raw, fail, False, []

    async def _get(self, path):
        self.calls.append(path)
        if self.fail:
            raise OSError("brak połączenia")
        return self.raw

    async def close(self):
        self.closed = True


def make_vpn_hub(monkeypatch, apis: dict, enabled=True):
    from netpulse import modules
    from netpulse.api.live import VpnLiveHub
    from netpulse.unifi_collector import ControllerTarget

    async def is_enabled(module):
        return enabled

    monkeypatch.setattr(modules, "is_enabled", is_enabled)
    hub = VpnLiveHub(api_factory=lambda t: apis[t.id])
    targets = [ControllerTarget(cid, f"K{cid}", "192.0.2.1", 443, "klucz", "default", False) for cid in apis]

    async def load():
        return targets

    hub._load_targets = load  # type: ignore[method-assign]
    return hub


VPN_RAW = {
    "data": [
        {"user": "iPhone", "tunnel_ip": "192.168.3.2", "remote_ip": "203.0.113.7", "assoc_time": 1763020000, "rx_bytes": 2000, "tx_bytes": 9000, "rx_rate": 1500, "tx_rate": 66_800_000},
        {"user": "Stary", "up": False},
    ]
}


def test_vpn_live_rates_are_bits_and_direction_is_from_client(monkeypatch):
    hub = make_vpn_hub(monkeypatch, {1: FakeVpnApi(VPN_RAW)})
    msg = asyncio.run(hub.sample())
    assert msg["ok"] is True
    assert [u["name"] for u in msg["users"]] == ["iPhone"]  # rozłączona sesja pominięta
    user = msg["users"][0]
    assert user["down_bps"] == 66_800_000  # bez ×8 – kontroler podaje bity/s
    assert user["up_bps"] == 1500
    assert user["down_bytes"] == 9000 and user["up_bytes"] == 2000
    assert user["since"].startswith("2025-11-13")


def test_vpn_live_not_ok_when_no_controller_answers(monkeypatch):
    broken = FakeVpnApi(fail=True)
    hub = make_vpn_hub(monkeypatch, {1: broken})
    msg = asyncio.run(hub.sample())
    assert msg == {"time": msg["time"], "ok": False, "users": []}
    assert broken.closed  # zepsuty klient odrzucony, następna próba z nowym


def test_vpn_live_one_controller_is_enough(monkeypatch):
    hub = make_vpn_hub(monkeypatch, {1: FakeVpnApi(fail=True), 2: FakeVpnApi(VPN_RAW)})
    msg = asyncio.run(hub.sample())
    assert msg["ok"] is True and len(msg["users"]) == 1


def test_vpn_live_disabled_module_asks_nobody(monkeypatch):
    api = FakeVpnApi(VPN_RAW)
    hub = make_vpn_hub(monkeypatch, {1: api}, enabled=False)
    msg = asyncio.run(hub.sample())
    assert msg["ok"] is False and api.calls == []


def test_vpn_websocket_requires_login():
    with pytest.raises(WebSocketDisconnect), TestClient(app).websocket_connect("/api/live/vpn"):
        pass
