"""Tryb „Na żywo”: wspólne odpytywanie WAN i WebSocket (bez bazy – lista interfejsów podstawiona)."""

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

WAN_IN = f"{O.IF_HC_IN_OCTETS}.8"
LAN_OUT = f"{O.IF_HC_OUT_OCTETS}.9"
TARGET = DeviceTarget(1, "ucg", "10.0.0.1", 161, "auto", SnmpCredentials(version="2c", community="public"))


def make_hub(**kw) -> tuple[LiveHub, SnmprecClient]:
    client = SnmprecClient.from_file(FIXTURES / "ucg-ultra.snmprec")
    hub = LiveHub(client_factory=lambda _t: client, interval=0.2, **kw)

    loaded: list[frozenset[int]] = []

    async def targets(device_ids):
        loaded.append(device_ids)
        ports = [LivePort(80, 8, 1000, wan=True, name="WAN 1")]
        if 1 in device_ids:
            ports.append(LivePort(90, 9, 1000, name="LAN"))
        return [LiveTarget(TARGET, tuple(ports))]

    hub._load_targets = targets  # type: ignore[method-assign]
    hub.loaded = loaded  # type: ignore[attr-defined]
    return hub, client


def test_live_rate_from_counter_difference():
    async def scenario():
        hub, client = make_hub()
        q = hub.subscribe()
        first = await asyncio.wait_for(q.get(), 5)
        assert first["in_bps"] is None  # pierwszy odczyt nie ma z czym porównać
        base = (await client.get([WAN_IN]))[WAN_IN]
        client.set(WAN_IN, base + 1_000_000)
        msg = await asyncio.wait_for(q.get(), 5)
        while msg["in_bps"] is None:
            msg = await asyncio.wait_for(q.get(), 5)
        assert 0 < msg["in_bps"] <= 1_000_000 * 8 / 0.1  # 1 MB w jednym–dwóch odstępach, rząd wielkości zgodny
        # każdy port WAN osobno, z nazwą łącza i prędkością do obciążenia w %
        [port] = msg["ports"]
        assert port["name"] == "WAN 1" and port["speed_mbps"] == 1000 and port["in_bps"] == msg["in_bps"]
        await hub.unsubscribe(q)
        assert hub._task is None and hub.viewers == 0

    asyncio.run(scenario())


def test_viewer_limit_and_shared_polling():
    async def scenario():
        hub, _ = make_hub(max_viewers=2)
        a, b = hub.subscribe(), hub.subscribe()
        assert a is not None and b is not None
        assert hub.subscribe() is None
        task = hub._task
        await hub.unsubscribe(a)
        assert hub._task is task  # drugi widz nadal korzysta z tego samego odpytywania
        await hub.unsubscribe(b)
        assert hub._task is None

    asyncio.run(scenario())


def test_device_ports_topic():
    """Widz strony urządzenia dostaje wszystkie jego porty; widz WAN – tylko WAN."""

    async def scenario():
        hub, client = make_hub()
        dev = hub.subscribe(1)
        wan = hub.subscribe("wan")
        msg = await asyncio.wait_for(dev.get(), 5)
        assert hub.loaded[-1] == frozenset({1})
        assert [p["id"] for p in msg["ports"]] == [80, 90] and "in_bps" not in msg
        base = (await client.get([LAN_OUT]))[LAN_OUT]
        client.set(LAN_OUT, base + 500_000)
        while True:
            msg = await asyncio.wait_for(dev.get(), 5)
            lan = next(p for p in msg["ports"] if p["id"] == 90)
            if lan["out_bps"]:
                break
        assert lan["out_bps"] > 0
        wan_msg = await asyncio.wait_for(wan.get(), 5)
        assert [p["id"] for p in wan_msg["ports"]] == [80]
        await hub.unsubscribe(dev)
        await hub.unsubscribe(wan)

    asyncio.run(scenario())


def test_only_wan_viewer_skips_other_devices():
    async def scenario():
        hub, _ = make_hub()
        q = hub.subscribe()
        await asyncio.wait_for(q.get(), 5)
        msgs = await hub.sample()
        assert set(msgs) == {"wan"} and hub.loaded[0] == frozenset()
        await hub.unsubscribe(q)

    asyncio.run(scenario())


def test_ports_websocket_requires_device_and_login():
    for path in ("/api/live/ports", "/api/live/ports?device=x", "/api/live/ports?device=1"):
        with pytest.raises(WebSocketDisconnect), TestClient(app).websocket_connect(path):
            pass


def test_websocket_requires_login():
    with pytest.raises(WebSocketDisconnect), TestClient(app).websocket_connect("/api/live/wan"):
        pass


def test_websocket_rejects_foreign_origin():
    headers = {"origin": "http://obca-strona.example"}
    with pytest.raises(WebSocketDisconnect), TestClient(app).websocket_connect("/api/live/wan", headers=headers):
        pass
