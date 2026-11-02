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
