"""Panele (0.27.0) na prawdziwej bazie: kolekcje bieżących wartości, stany w czasie i pulpit publiczny.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta
from itertools import groupby

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from netpulse.api import app  # noqa: E402
from netpulse.api.public import pin_limiter  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import (  # noqa: E402
    Agent,
    Controller,
    Device,
    DeviceMetric,
    DiskMetric,
    Interface,
    InterfaceMetric,
    NetworkClient,
    User,
    WifiMetric,
    WifiNetwork,
)

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


def ago(minutes: float) -> datetime:
    return datetime.now(UTC) - timedelta(minutes=minutes)


async def _clean():
    async with Session() as s, s.begin():
        await s.execute(delete(Device))
        await s.execute(delete(Controller))
        await s.execute(delete(User))


@pytest.fixture
def lab():
    login_limiter._failures.clear()
    pin_limiter._failures.clear()

    async def go():
        await init_db()
        await _clean()
        async with Session() as s, s.begin():
            sw = Device(name="USW", host="10.0.0.2", community="public", kind="switch", status="up", uptime_s=3600)
            ap = Device(name="U6+", host="10.0.0.3", community="public", kind="ap", status="down")
            nas = Device(name="NAS", host="nas", port=0, driver="agent", kind="server", status="up")
            s.add_all([sw, ap, nas])
            await s.flush()
            port = Interface(device_id=sw.id, if_index=3, name="0/3", label="Port 3", alias="AP U6+", oper_status="up", speed_mbps=1000)
            s.add(port)
            wifi = WifiNetwork(device_id=ap.id, key="ra0", ssid="Dom", radio="ng", clients=7)
            s.add(wifi)
            await s.flush()
            # Switch: 4 udane odczyty; AP: działał, potem przestał
            for i in range(4):
                s.add(DeviceMetric(time=ago(8 - i * 2), device_id=sw.id, reachable=True, cpu_percent=10.0 + i, mem_used_percent=40.0))
                s.add(DeviceMetric(time=ago(8 - i * 2), device_id=ap.id, reachable=i < 2))
                s.add(InterfaceMetric(time=ago(8 - i * 2), interface_id=port.id, in_bps=1e6 * (i + 1), out_bps=2e5, oper_up=True))
            s.add(WifiMetric(time=ago(1), wifi_id=wifi.id, clients=7, rx_bps=5e5, tx_bps=1e6))
            s.add(Agent(device_id=nas.id, token_hash="x" * 64, token_hint="abcd", inventory={"containers": [
                {"name": "nextcloud", "state": "running", "cpu_percent": 2.5, "mem_bytes": 5e8},
                {"name": "stary", "state": "exited"},
            ]}))
            s.add(DeviceMetric(time=ago(1), device_id=nas.id, reachable=True, cpu_percent=5.0))
            s.add(DiskMetric(time=ago(1), device_id=nas.id, mount="/", total_bytes=100 * 10**9, used_bytes=30 * 10**9))
            s.add(DiskMetric(time=ago(1), device_id=nas.id, mount="/mnt/data", total_bytes=4000 * 10**9, used_bytes=3600 * 10**9))
            c = Controller(name="UniFi", host="10.0.0.1", api_key="k")
            s.add(c)
            await s.flush()
            s.add(NetworkClient(controller_id=c.id, mac="aa:bb:cc:dd:ee:01", name="Telefon", ip="10.0.0.50", is_wired=False, signal_dbm=-61, rx_rate_kbps=866000, updated_at=ago(1)))
            return {"sw": sw.id, "ap": ap.id, "nas": nas.id, "port": port.id}

    ids = run(go)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c, ids
    run(_clean)


def rows(client, kind, **params):
    res = client.get(f"/api/collections/{kind}", params=params)
    assert res.status_code == 200, res.text
    return {r["label"]: r["values"] for r in res.json()["rows"]}


def test_collections(lab):
    client, ids = lab
    devices = rows(client, "devices")
    assert devices["USW"]["up"] == 1.0 and devices["USW"]["cpu_percent"] == 13.0 and devices["USW"]["uptime_s"] == 3600
    assert devices["U6+"]["up"] == 0.0
    ports = rows(client, "ports", device_id=ids["sw"])
    assert ports["Port 3 (AP U6+)"] == {"up": 1.0, "in_bps": 4e6, "out_bps": 2e5, "speed_mbps": 1000.0}
    assert client.get("/api/collections/ports").status_code == 422  # bez urządzenia
    assert client.get("/api/collections/ports", params={"device_id": 999999}).status_code == 404
    assert rows(client, "wifi") == {"Dom (2,4 GHz)": {"clients": 7.0, "rx_bps": 5e5, "tx_bps": 1e6}}
    disks = rows(client, "disks", device_id=ids["nas"])
    assert disks["/mnt/data"]["used_percent"] == 90.0 and disks["/"]["free_bytes"] == 70 * 10**9
    containers = rows(client, "containers", device_id=ids["nas"])
    assert containers == {"nextcloud": {"up": 1.0, "cpu_percent": 2.5, "mem_bytes": 5e8}, "stary": {"up": 0.0, "cpu_percent": None, "mem_bytes": None}}
    clients = client.get("/api/collections/clients").json()["rows"]
    assert clients[0]["label"] == "Telefon" and clients[0]["values"]["signal_dbm"] == -61 and "aa:bb" not in str(clients)


def test_states(lab):
    client, ids = lab
    res = client.get("/api/states", params={"devices": f"{ids['sw']},{ids['ap']}", "interfaces": str(ids["port"]), "minutes": 15})
    assert res.status_code == 200, res.text
    items = {(i["kind"], i["label"]): [s["state"] for s in i["segments"]] for i in res.json()["items"]}
    assert "up" in items[("device", "USW")] and "down" not in items[("device", "USW")]
    ap = [state for state, _ in groupby(s for s in items[("device", "U6+")] if s != "unknown")]
    assert ap == ["up", "down"]  # działał, potem przestał
    assert "up" in items[("interface", "USW: Port 3")]
    everything = client.get("/api/states", params={"minutes": 15}).json()["items"]
    assert {i["label"] for i in everything} == {"USW", "U6+", "NAS"}  # bez listy: wszystkie urządzenia
    assert client.get("/api/states", params={"devices": "x"}).status_code == 422


def test_public_dashboard_serves_panel_data(lab):
    client, ids = lab
    layout = {
        "version": 1,
        "widgets": [
            {"id": "s", "type": "stat", "w": 3, "config": {"source": {"kind": "device", "id": ids["sw"]}, "key": "cpu_percent"}},
            {"id": "b", "type": "bargauge", "w": 6, "config": {"collection": {"kind": "disks", "device_id": ids["nas"]}, "key": "used_percent"}},
            {"id": "t", "type": "table", "w": 6, "config": {"collection": {"kind": "devices"}, "columns": ["up", "cpu_percent"]}},
            {"id": "o", "type": "state_timeline", "w": 12, "config": {"items": [{"kind": "device", "id": ids["ap"]}]}},
        ],
    }
    wall = client.post("/api/dashboards", json={"name": "Ściana", "layout": layout}).json()
    token = client.put(f"/api/dashboards/{wall['id']}/public", json={"enabled": True}).json()["public"]["token"]
    with TestClient(app) as tv:
        data = lambda path: tv.get(f"/api/public/dashboards/{token}/data", params={"path": path})  # noqa: E731
        assert data(f"/api/devices/{ids['sw']}/metrics?minutes=60").status_code == 200
        assert data(f"/api/collections/disks?device_id={ids['nas']}").json()["rows"][0]["label"] == "/"
        assert data("/api/collections/devices").status_code == 200
        assert data(f"/api/states?devices={ids['ap']}&minutes=60").json()["items"][0]["label"] == "U6+"
        # Czego nie ma na pulpicie, tego nie ma
        assert data(f"/api/collections/ports?device_id={ids['sw']}").status_code == 403
        assert data(f"/api/collections/disks?device_id={ids['sw']}").status_code == 403
        assert data(f"/api/states?devices={ids['sw']}&minutes=60").status_code == 403
        assert data("/api/states?minutes=60").status_code == 403
        assert data(f"/api/devices/{ids['ap']}/metrics?minutes=60").status_code == 403
