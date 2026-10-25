"""Szczegóły urządzenia i portu na prawdziwej bazie: agregaty godzinowe, dostępność w %, port z PoE, długie zakresy.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy z TimescaleDB).
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete, text  # noqa: E402

from netpulse import aggregates  # noqa: E402
from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.config import settings  # noqa: E402
from netpulse.db import Session, engine, has_timescale, init_db  # noqa: E402
from netpulse.db.models import Device, DeviceMetric, Interface, InterfaceMetric, PoePortMetric, User  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


async def _clean():
    async with Session() as s, s.begin():
        await s.execute(delete(Device))
        await s.execute(delete(User))


def ago(minutes: float) -> datetime:
    # Próbki z ostatnich minut: agregat „na żywo” liczy je z surowych danych (powyżej ostatniego odświeżenia)
    return datetime.now(UTC) - timedelta(minutes=minutes)


@pytest.fixture
def switch():
    login_limiter._failures.clear()

    async def go():
        await init_db()
        await _clean()
        async with Session() as s, s.begin():
            dev = Device(name="USW Lite", host="10.0.0.2", community="public", kind="switch", status="up")
            s.add(dev)
            await s.flush()
            port = Interface(device_id=dev.id, if_index=3, name="0/3", label="Port 3", alias="AP U6+", oper_status="up", speed_mbps=1000)
            s.add(port)
            await s.flush()
            # 4 odczyty urządzenia: 3 udane, 1 bez odpowiedzi
            for i, ok in enumerate([True, True, False, True]):
                s.add(DeviceMetric(time=ago(20 - i), device_id=dev.id, reachable=ok, cpu_percent=10.0 + i if ok else None))
            # Port: 2 próbki podłączony, 2 odłączony
            for i, up in enumerate([True, False, False, True]):
                s.add(InterfaceMetric(time=ago(20 - i), interface_id=port.id, in_bps=1e6, out_bps=2e5, oper_up=up))
            s.add(PoePortMetric(time=ago(5), device_id=dev.id, port_idx=3, power_w=4.5, delivering=True))
            s.add(PoePortMetric(time=ago(5), device_id=dev.id, port_idx=4, power_w=9.0, delivering=True))
            return dev.id, port.id

    ids = run(go)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c, ids
    run(_clean)


def test_aggregates_are_created():
    async def go():
        await init_db()
        async with engine.connect() as conn:
            if not await has_timescale(conn):
                return None
            rows = await conn.execute(text("SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates"))
            return {r.view_name: r.materialized_only for r in rows}

    views = run(go)
    if views is None:
        pytest.skip("baza bez TimescaleDB")
    for a in aggregates.AGGREGATES:
        assert views.get(a.view) is False, views  # „na żywo”: świeże dane widoczne od razu
    # Drugie uruchomienie niczego nie zakłada od nowa
    assert run(lambda: aggregates.ensure(engine, 30, 730)) == []


def test_bucket_sizes():
    assert aggregates.bucket_seconds(60) == 30
    assert aggregates.bucket_seconds(10080) == 2016
    assert aggregates.bucket_seconds(43200) == 3 * 3600
    assert aggregates.bucket_seconds(525600) == 48 * 3600


def test_device_availability(switch):
    client, (dev_id, _port_id) = switch
    res = client.get(f"/api/devices/{dev_id}/availability", params={"days": 30})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["samples"] == 4 and body["percent"] == pytest.approx(75.0)
    assert body["down_s"] == settings.poll_interval
    assert body["daily"] and sum(d["samples"] for d in body["daily"]) == 4

    listed = {x["device_id"]: x for x in client.get("/api/availability", params={"days": 7}).json()}
    assert listed[dev_id]["percent"] == pytest.approx(75.0)
    assert client.get("/api/devices/999999/availability").status_code == 404
    assert client.get(f"/api/devices/{dev_id}/availability", params={"days": 0}).status_code == 422


def test_interface_details_and_poe(switch):
    client, (dev_id, port_id) = switch
    port = client.get(f"/api/interfaces/{port_id}").json()
    assert (port["device_id"], port["device_name"], port["device_kind"]) == (dev_id, "USW Lite", "switch")
    assert port["poe_port_idx"] == 3 and port["alias"] == "AP U6+"
    assert port["in_bps"] == pytest.approx(1e6)

    avail = client.get(f"/api/interfaces/{port_id}/availability", params={"days": 1}).json()
    assert avail["samples"] == 4 and avail["percent"] == pytest.approx(50.0)

    poe = client.get(f"/api/interfaces/{port_id}/poe-metrics", params={"minutes": 60}).json()
    assert [p["values"]["power_w"] for p in poe] == [pytest.approx(4.5)]  # tylko port 3, nie 4
    assert client.get("/api/interfaces/999999").status_code == 404


def test_long_ranges(switch):
    client, (dev_id, port_id) = switch
    for minutes in (43200, 525600):
        series = client.get(f"/api/devices/{dev_id}/metrics", params={"minutes": minutes})
        assert series.status_code == 200, series.text
        cpu = [p["values"]["cpu_percent"] for p in series.json() if p["values"]["cpu_percent"] is not None]
        assert cpu and 10 <= cpu[0] <= 13
        traffic = client.get(f"/api/interfaces/{port_id}/metrics", params={"minutes": minutes}).json()
        assert traffic and traffic[0]["values"]["in_bps"] == pytest.approx(1e6)
        assert client.get("/api/dashboard/traffic", params={"minutes": minutes}).status_code == 200
        assert client.get("/api/dashboard/wifi", params={"minutes": minutes}).status_code == 200
    assert client.get(f"/api/devices/{dev_id}/metrics", params={"minutes": 60 * 24 * 400}).status_code == 422
