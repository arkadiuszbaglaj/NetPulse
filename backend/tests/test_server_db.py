"""Serwer Linux przez SNMP: kolektor zapisuje dyski i swap, API podaje bieżący stan.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os

import pytest
from conftest import FIXTURES

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete, func, select  # noqa: E402

from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.collector import Collector  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Device, DiskMetric, ServerMetric, User  # noqa: E402
from netpulse.snmp.snmprec import SnmprecClient  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
HOST = "10.0.0.50"


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


async def reset():
    await init_db()
    async with Session() as s, s.begin():
        await s.execute(delete(Device))
        await s.execute(delete(User))


@pytest.fixture
def client():
    run(reset)
    login_limiter._failures.clear()
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(reset)


def poll_server() -> None:
    snmp = SnmprecClient.from_file(FIXTURES / "linux-server.snmprec")

    async def go():
        async with Session() as s, s.begin():
            s.add(Device(name="homelab-srv", host=HOST, community="public"))
        await Collector(client_factory=lambda _t: snmp).poll_all()

    run(go)


def test_collector_saves_server_state(client):
    poll_server()

    async def check():
        async with Session() as s:
            dev = await s.scalar(select(Device))
            assert dev.kind == "server" and dev.detected_driver == "linux" and dev.firmware == "6.8.0-45-generic"
            disks = {d.mount: d for d in (await s.scalars(select(DiskMetric))).all()}
            assert set(disks) == {"/", "/boot", "/mnt/data"}
            assert disks["/"].total_bytes == 15_000_000 * 4096
            extra = await s.scalar(select(ServerMetric))
            assert extra.swap_used_percent == 25.0 and extra.processes == 213
            assert await s.scalar(select(func.count()).select_from(DiskMetric)) == 3

    run(check)


def test_server_endpoint(client):
    poll_server()
    (device,) = client.get("/api/devices").json()
    assert device["kind"] == "server"
    state = client.get(f"/api/devices/{device['id']}/server").json()
    assert state["cpu_percent"] == 13.0 and state["mem_used_percent"] == 35.0 and state["load1"] == 0.52
    assert state["swap_used_percent"] == 25.0 and state["processes"] == 213
    assert [d["mount"] for d in state["disks"]] == ["/", "/boot", "/mnt/data"]
    data = next(d for d in state["disks"] if d["mount"] == "/mnt/data")
    assert data["used_percent"] == 89.8 and data["total_bytes"] == 732_421_875 * 4096


def test_server_endpoint_edge_cases(client):
    assert client.get("/api/devices/99999/server").status_code == 404
    run(_add_unpolled)
    (device,) = client.get("/api/devices").json()
    assert client.get(f"/api/devices/{device['id']}/server").json() is None  # nie było jeszcze odczytu


async def _add_unpolled():
    async with Session() as s, s.begin():
        s.add(Device(name="nowy", host=HOST, community="public"))


def test_server_endpoint_requires_login():
    with TestClient(app) as c:
        assert c.get("/api/devices/1/server").status_code == 401
