"""API wykrywania i raportu urządzenia na prawdziwej bazie (0.73.0).

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from conftest import FIXTURES  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from netpulse import discovery  # noqa: E402
from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Device, User  # noqa: E402
from netpulse.drivers.generic import read_system  # noqa: E402
from netpulse.snmp import client as snmp_client  # noqa: E402
from netpulse.snmp.snmprec import SnmprecClient  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


async def _reset():
    await init_db()
    async with Session() as s, s.begin():
        await s.execute(delete(Device))
        await s.execute(delete(User))


async def _seed():
    async with Session() as s, s.begin():
        s.add(Device(name="UCG", host="192.168.7.1", community="public", kind="gateway"))
        s.add(Device(name="Agent", host="192.168.7.50", driver="agent"))


@pytest.fixture
def client():
    login_limiter._failures.clear()
    run(_reset)
    run(_seed)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(_reset)


def test_suggest_uses_device_subnet(client):
    assert client.get("/api/discovery/suggest").json() == {"network": "192.168.7.0/24"}


def test_scan_marks_known_devices(client, monkeypatch):
    seen = {}

    async def fake_discover(hosts, creds, port=161):
        seen.update(hosts=len(hosts), community=creds.community, port=port)
        out = []
        for host, fx in (("192.168.7.1", "ucg-ultra.snmprec"), ("192.168.7.3", "u6-plus.snmprec")):
            out.append(discovery.describe(host, await read_system(SnmprecClient.from_file(FIXTURES / fx))))
        return out

    monkeypatch.setattr(discovery, "discover", fake_discover)
    r = client.post("/api/discovery/scan", json={"network": "192.168.7.0/24", "community": "tajne"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["scanned"] == 254 and seen == {"hosts": 254, "community": "tajne", "port": 161}
    by_host = {f["host"]: f for f in data["found"]}
    assert by_host["192.168.7.1"]["device_id"] is not None and by_host["192.168.7.1"]["kind"] == "gateway"
    assert by_host["192.168.7.3"]["device_id"] is None and by_host["192.168.7.3"]["driver"] == "unifi"
    assert by_host["192.168.7.3"]["suggested_name"]
    assert "tajne" not in r.text


def test_scan_validates_range_and_credentials(client):
    assert client.post("/api/discovery/scan", json={"network": "10.0.0.0/16"}).status_code == 422
    assert client.post("/api/discovery/scan", json={"network": "192.168.7.0/24", "snmp_version": "3"}).status_code == 422


def test_device_report_is_anonymized(client, monkeypatch):
    monkeypatch.setattr(snmp_client, "PySnmpClient", lambda *a, **k: SnmprecClient.from_file(FIXTURES / "u6-plus.snmprec"))
    dev = next(d for d in client.get("/api/devices").json() if d["name"] == "UCG")
    r = client.post(f"/api/devices/{dev['id']}/report?interval=0")
    assert r.status_code == 200, r.text
    report = r.json()
    assert report["format"] == "netpulse-device-report" and report["records"] > 100
    assert "192.168.7.1" not in r.text and "public" not in r.text
    agent = next(d for d in client.get("/api/devices").json() if d["name"] == "Agent")
    assert client.post(f"/api/devices/{agent['id']}/report?interval=0").status_code == 409
    assert client.post("/api/devices/999999/report?interval=0").status_code == 404


def test_discovery_requires_login():
    with TestClient(app) as anon:
        assert anon.get("/api/discovery/suggest").status_code == 401
        assert anon.post("/api/discovery/scan", json={"network": "192.168.7.0/24"}).status_code in (401, 403)
