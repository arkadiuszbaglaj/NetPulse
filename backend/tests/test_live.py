"""Tryb „Na żywo”: wspólne odpytywanie WAN i WebSocket (bez bazy – lista interfejsów podstawiona)."""

from __future__ import annotations

import asyncio

import pytest
from conftest import FIXTURES
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from netpulse.api import app
from netpulse.api.live import LiveHub, WanTarget
from netpulse.collector import DeviceTarget
from netpulse.snmp import SnmpCredentials
from netpulse.snmp import oids as O
from netpulse.snmp.snmprec import SnmprecClient

WAN_IN = f"{O.IF_HC_IN_OCTETS}.8"
TARGET = DeviceTarget(1, "ucg", "10.0.0.1", 161, "auto", SnmpCredentials(version="2c", community="public"))


def make_hub(**kw) -> tuple[LiveHub, SnmprecClient]:
    client = SnmprecClient.from_file(FIXTURES / "ucg-ultra.snmprec")
    hub = LiveHub(client_factory=lambda _t: client, interval=0.2, **kw)

    async def targets():
        return [WanTarget(TARGET, (8,), (1000,))]

    hub._load_targets = targets  # type: ignore[method-assign]
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


def test_websocket_requires_login():
    with pytest.raises(WebSocketDisconnect), TestClient(app).websocket_connect("/api/live/wan"):
        pass


def test_websocket_rejects_foreign_origin():
    headers = {"origin": "http://obca-strona.example"}
    with pytest.raises(WebSocketDisconnect), TestClient(app).websocket_connect("/api/live/wan", headers=headers):
        pass
