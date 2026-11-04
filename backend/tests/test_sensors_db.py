"""Czujniki, PoE i SFP MikroTika (od 0.50.0): kolektor zapisuje je w `metrics`, API podaje stan, wykres i alert.

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
from sqlalchemy import delete, select  # noqa: E402

from netpulse.alerts import AlertEngine  # noqa: E402
from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.collector import Collector  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Alert, AlertRule, Device, Metric, User  # noqa: E402
from netpulse.modules import get_modules, save_modules  # noqa: E402
from netpulse.snmp.snmprec import SnmprecClient  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
MT = "1.3.6.1.4.1.14988.1.1"
# hEX S: PoE na ether5, moduł w sfp1 (tabele z oficjalnego MIKROTIK-MIB)
EXTRA = {
    f"{MT}.15.1.1.2.5": b"ether5",
    f"{MT}.15.1.1.3.5": 3,
    f"{MT}.15.1.1.4.5": 238,
    f"{MT}.15.1.1.6.5": 36,
    f"{MT}.19.1.1.2.6": b"sfp1",
    f"{MT}.19.1.1.3.6": 1,
    f"{MT}.19.1.1.6.6": 41,
    f"{MT}.19.1.1.9.6": -5871,
    f"{MT}.19.1.1.10.6": -31000,
    f"{MT}.19.1.1.13.6": 1,
}


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
        await s.execute(delete(Alert))
        await s.execute(delete(AlertRule))
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


def poll_mikrotik() -> int:
    snmp = SnmprecClient.from_file(FIXTURES / "mikrotik-hex.snmprec")
    for oid, value in EXTRA.items():
        snmp.set(oid, value)

    async def go():
        async with Session() as s, s.begin():
            dev = Device(name="hex", host="10.0.0.60", community="public")
            s.add(dev)
        await Collector(client_factory=lambda _t: snmp).poll_all()
        return dev.id

    return run(go)


def test_collector_saves_sensors_and_api_shows_them(client):
    dev_id = poll_mikrotik()

    async def stored():
        async with Session() as s:
            return {(m.name, m.key): m.value for m in (await s.scalars(select(Metric).where(Metric.device_id == dev_id))).all()}

    m = run(stored)
    assert m[("temp_c", "cpu-temperature")] == 46 and m[("voltage_v", "voltage")] == 24.1
    assert m[("poe_power_w", "ether5")] == 3.6 and m[("sfp_rx_dbm", "sfp1")] == -31.0

    data = client.get(f"/api/devices/{dev_id}/sensors").json()
    assert data["sensors"] == [
        {"key": "cpu-temperature", "metric": "temp_c", "value": 46.0},
        {"key": "voltage", "metric": "voltage_v", "value": 24.1},
    ]
    assert data["poe"] == [{"port": "ether5", "state": 3, "power_w": 3.6, "voltage_v": 23.8}]
    sfp = data["sfp"][0]
    assert (sfp["port"], sfp["rx_dbm"], sfp["rx_loss"], sfp["tx_fault"]) == ("sfp1", -31.0, True, None)

    keys = client.get(f"/api/devices/{dev_id}/agent-keys").json()
    assert keys["snmp_sensor"] == ["cpu-temperature", "voltage"]
    assert keys["snmp_poe"] == ["ether5"] and keys["snmp_sfp"] == ["sfp1"]
    series = client.get(f"/api/devices/{dev_id}/agent-metrics", params={"source": "snmp_sfp", "key": "sfp1", "minutes": 60}).json()
    assert series[0]["values"]["sfp_rx_dbm"] == -31.0 and series[0]["values"]["sfp_temp_c"] == 41.0


def test_sfp_and_temperature_alerts_without_agents_module(client):
    """Temperatura i słaby sygnał SFP z MikroTika alarmują także przy wyłączonym module agentów."""
    metrics = {m["metric"]: m for m in client.get("/api/alert-rules/metrics").json()}
    assert metrics["sfp_rx_dbm"]["per_device"] and metrics["sfp_rx_dbm"]["matchable"]
    for body in (
        {"name": "SFP", "kind": "metric", "metric": "sfp_rx_dbm", "op": "<", "threshold": -25, "duration_s": 0},
        {"name": "Temp", "kind": "metric", "metric": "temp_c", "op": ">", "threshold": 40, "duration_s": 0},
    ):
        assert client.post("/api/alert-rules", json=body).status_code == 201
    before = run(get_modules)
    run(lambda: save_modules({"agents": False}))
    try:
        poll_mikrotik()

        async def firing():
            await AlertEngine().evaluate()
            async with Session() as s:
                rows = await s.scalars(
                    select(Alert).join(AlertRule, AlertRule.id == Alert.rule_id).where(Alert.state == "firing", AlertRule.name.in_(["SFP", "Temp"]))
                )
                return sorted(a.title for a in rows.all())

        assert run(firing) == ["hex: SFP moc odbierana sfp1 -31,0 dBm", "hex: temperatura cpu-temperature 46,0°C"]
    finally:
        run(lambda: save_modules(before))
