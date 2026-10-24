"""Kolektor + prawdziwa baza (PostgreSQL/TimescaleDB).

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os

import pytest
from conftest import FIXTURES

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from sqlalchemy import delete, func, select  # noqa: E402

from netpulse.collector import Collector  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import (  # noqa: E402
    Device,
    DeviceMetric,
    Interface,
    InterfaceMetric,
    WifiMetric,
    WifiNetwork,
)
from netpulse.snmp import oids as O  # noqa: E402
from netpulse.snmp.snmprec import SnmprecClient  # noqa: E402

HOSTS = {"10.0.0.1": "ucg-ultra", "10.0.0.2": "usw-lite-8-poe", "10.0.0.3": "u6-plus"}


def test_collector_end_to_end():
    clients = {h: SnmprecClient.from_file(FIXTURES / f"{f}.snmprec") for h, f in HOSTS.items()}

    async def scenario():
        timescale = await init_db()
        async with Session() as s, s.begin():
            await s.execute(delete(Device))
            for host, fixture in HOSTS.items():
                s.add(Device(name=fixture, host=host, community="public"))
            s.add(Device(name="offline", host="10.0.0.99", community="public"))

        def factory(target):
            if target.host not in clients:
                from netpulse.snmp import SnmpError

                class Dead:
                    async def get(self, oids):
                        raise SnmpError("timeout")

                    async def walk(self, oid):
                        raise SnmpError("timeout")

                    async def close(self):
                        pass

                return Dead()
            return clients[target.host]

        collector = Collector(client_factory=factory)
        await collector.poll_all()

        # Przyrost liczników: +12.5 MB na WAN w ~1 s
        wan_in = f"{O.IF_HC_IN_OCTETS}.8"
        ucg = clients["10.0.0.1"]
        base = (await ucg.get([wan_in]))[wan_in]
        await asyncio.sleep(1.0)
        ucg.set(wan_in, base + 12_500_000)
        await collector.poll_all()

        async with Session() as s:
            devices = {d.host: d for d in (await s.scalars(select(Device))).all()}
            assert devices["10.0.0.1"].status == "up"
            assert devices["10.0.0.1"].kind == "gateway"
            assert devices["10.0.0.2"].kind == "switch"
            assert devices["10.0.0.3"].kind == "ap"
            assert devices["10.0.0.99"].status == "down"
            assert devices["10.0.0.99"].last_error

            n_if = await s.scalar(select(func.count()).select_from(Interface))
            assert n_if > 20
            wan = await s.scalar(
                select(Interface).where(Interface.device_id == devices["10.0.0.1"].id, Interface.name == "eth4")
            )
            assert wan.label == "WAN" and wan.role == "wan"
            metric = await s.scalar(select(InterfaceMetric).where(InterfaceMetric.interface_id == wan.id))
            assert metric is not None
            # 12.5 MB w ~1 s ≈ 100 Mb/s
            assert 40e6 < metric.in_bps < 110e6, metric.in_bps

            assert await s.scalar(select(func.count()).select_from(WifiNetwork)) == 6
            assert await s.scalar(select(func.count()).select_from(WifiMetric)) == 12
            assert await s.scalar(select(func.count()).select_from(DeviceMetric)) == 8
        await engine.dispose()
        return timescale

    asyncio.run(scenario())


def test_old_schema_is_detected():
    """Baza ze starszej wersji (brak kolumny) → czytelny błąd zamiast błędów SQL."""
    from sqlalchemy import text

    from netpulse.db import SchemaMismatchError, missing_columns

    async def scenario():
        await init_db()
        async with engine.connect() as conn:
            assert await conn.run_sync(missing_columns) == {}
            trans = await conn.begin()
            await conn.execute(text("ALTER TABLE devices DROP COLUMN port"))
            assert await conn.run_sync(missing_columns) == {"devices": ["port"]}
            await trans.rollback()
        await engine.dispose()

    asyncio.run(scenario())
    assert issubclass(SchemaMismatchError, RuntimeError)


def test_api_endpoints():
    from fastapi.testclient import TestClient

    from netpulse.api import app

    with TestClient(app) as client:
        _check_api(client)


def _check_api(client):
    assert client.get("/api/health").json()["status"] == "ok"
    devices = client.get("/api/devices").json()
    assert len(devices) == 4
    assert "community" not in devices[0]
    ucg = next(d for d in devices if d["kind"] == "gateway")
    ports = client.get(f"/api/devices/{ucg['id']}/interfaces").json()
    assert [p["label"] for p in ports] == ["WAN", "LAN 1", "LAN 2", "LAN 3", "LAN 4"]
    wan = ports[0]
    assert wan["in_bps"] is not None
    series = client.get(f"/api/interfaces/{wan['id']}/metrics?minutes=60").json()
    assert len(series) >= 1
    ap = next(d for d in devices if d["kind"] == "ap")
    wifi = client.get(f"/api/devices/{ap['id']}/wifi").json()
    assert len(wifi) == 3
