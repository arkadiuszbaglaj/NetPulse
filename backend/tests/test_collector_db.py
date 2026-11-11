"""Kolektor + prawdziwa baza (PostgreSQL/TimescaleDB).

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime

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
            # +12.5 MB między dwoma odczytami; czas z rzeczywistych znaczników odczytów
            # (na wolnym CI pierwszy zapis potrafi trwać kilka sekund)
            t1, t2 = (
                await s.scalars(
                    select(DeviceMetric.time)
                    .where(DeviceMetric.device_id == devices["10.0.0.1"].id)
                    .order_by(DeviceMetric.time)
                )
            ).all()
            expected = 12_500_000 * 8 / (t2 - t1).total_seconds()
            assert abs(metric.in_bps - expected) < expected * 0.01, (metric.in_bps, expected)

            assert await s.scalar(select(func.count()).select_from(WifiNetwork)) == 6
            assert await s.scalar(select(func.count()).select_from(WifiMetric)) == 12
            assert await s.scalar(select(func.count()).select_from(DeviceMetric)) == 8

        # Interfejs, którego nie ma w odczycie (WireGuard bramy między połączeniami): „nieobecny”, bez próbek
        async with Session() as s, s.begin():
            gone = Interface(device_id=devices["10.0.0.1"].id, if_index=90497, name="wgsrv1", label="WG-Home", role="vpn", oper_status="up")
            s.add(gone)
        await collector.poll_all()
        async with Session() as s:
            gone = await s.get(Interface, gone.id)
            assert gone.oper_status == "notPresent"
            assert await s.scalar(select(func.count()).select_from(InterfaceMetric).where(InterfaceMetric.interface_id == gone.id)) == 0
            wan = await s.get(Interface, wan.id)
            assert wan.oper_status == "up"
        async with Session() as s, s.begin():
            await s.execute(delete(Interface).where(Interface.id == gone.id))  # następny test liczy porty bramy
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
            trans = await conn.begin()
            assert await conn.run_sync(missing_columns) == {}
            # DDL w PostgreSQL jest transakcyjne – rollback przywraca kolumnę
            await conn.execute(text("ALTER TABLE devices DROP COLUMN port"))
            assert await conn.run_sync(missing_columns) == {"devices": ["port"]}
            await trans.rollback()
        await engine.dispose()

    asyncio.run(scenario())
    assert issubclass(SchemaMismatchError, RuntimeError)


def test_api_endpoints():
    from fastapi.testclient import TestClient

    from netpulse.api import app
    from netpulse.db.models import User

    async def reset_users():
        async with Session() as s, s.begin():
            await s.execute(delete(User))
        await engine.dispose()

    asyncio.run(reset_users())
    with TestClient(app) as client:
        assert client.get("/api/devices").status_code == 401
        assert client.post("/api/auth/setup", json={"username": "admin", "password": "haslo-testowe-1"}).status_code == 201
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


# UniFi OS 5.1 → 6.0 na UCG Ultra: zniknęły bond0 (7), ifb0 (10), ifb1 (11), reszta przesunęła się w dół
UCG_6_RENUMBER = {8: 7, 9: 8, 12: 9, 13: 10, 14: 11, 15: 12, 16: 13, 17: 14}
IF_TABLES = ("1.3.6.1.2.1.2.2.1.", "1.3.6.1.2.1.31.1.1.1.")  # ifTable, ifXTable


def _renumbered(data: dict) -> dict:
    out = {}
    for oid, value in data.items():
        table = next((t for t in IF_TABLES if oid.startswith(t)), None)
        if table is None:
            out[oid] = value
            continue
        column, idx = oid[len(table) :].split(".", 1)
        if int(idx) in UCG_6_RENUMBER:
            out[f"{table}{column}.{UCG_6_RENUMBER[int(idx)]}"] = value
        elif int(idx) not in (7, 10, 11):
            out[oid] = value
    return out


def test_ifindex_renumbering_keeps_port_rows():
    """Po przesunięciu numerów ifIndex wiersz portu (historia, łącza WAN) idzie za nazwą."""
    from netpulse.db.models import WanLink

    before = SnmprecClient.from_file(FIXTURES / "ucg-ultra.snmprec")
    clients = {"before": before}

    async def scenario():
        await init_db()
        async with Session() as s, s.begin():
            await s.execute(delete(Device))
            s.add(Device(name="ucg", host="10.0.0.1", community="public"))
        class Current:  # kolektor trzyma klienta urządzenia – podmiana danych przez pośrednika
            async def get(self, oids):
                return await clients["now"].get(oids)

            async def walk(self, oid):
                return await clients["now"].walk(oid)

            async def close(self):
                pass

        collector = Collector(client_factory=lambda target: Current())
        clients["now"] = before
        await collector.poll_all()
        await collector.poll_all()
        async with Session() as s, s.begin():
            dev = await s.scalar(select(Device))
            rows = {i.name: i for i in (await s.scalars(select(Interface).where(Interface.device_id == dev.id))).all()}
            assert rows["eth4"].if_index == 8 and rows["eth3"].if_index == 15
            ids = {name: rows[name].id for name in ("eth4", "eth3", "bond0", "switch0")}
            # WAN 1 założony sam (eth4), WAN 2 = eth3 (jak GSM użytkownika)
            s.add(WanLink(device_id=dev.id, interface_id=ids["eth3"], position=2, name="GSM", state="unknown"))

        after = SnmprecClient(_renumbered(dict(before._data)))
        clients["now"] = after
        cut = datetime.now(UTC)
        await collector.poll_all()
        await collector.poll_all()

        async with Session() as s:
            rows = {i.id: i for i in (await s.scalars(select(Interface).where(Interface.device_id == dev.id))).all()}
            assert (rows[ids["eth4"]].name, rows[ids["eth4"]].if_index, rows[ids["eth4"]].role) == ("eth4", 7, "wan")
            assert (rows[ids["eth3"]].name, rows[ids["eth3"]].if_index, rows[ids["eth3"]].role) == ("eth3", 12, "wan")
            assert (rows[ids["switch0"]].name, rows[ids["switch0"]].if_index) == ("switch0", 8)
            # bond0 zniknął, a jego numer zajął eth4 – odstawiony, nieobecny
            assert rows[ids["bond0"]].if_index == -ids["bond0"] and rows[ids["bond0"]].oper_status == "notPresent"
            links = {link.name: link.interface_id for link in (await s.scalars(select(WanLink))).all()}
            assert links == {"WAN 1": ids["eth4"], "GSM": ids["eth3"]}
            # Liczniki pod numerem 7 należały wcześniej do bond0 – bez fałszywego ruchu (fixture stoi, więc ruch = 0)
            rates = (
                await s.scalars(
                    select(InterfaceMetric.in_bps).where(InterfaceMetric.interface_id == ids["eth4"], InterfaceMetric.time >= cut)
                )
            ).all()
            assert all(not v for v in rates), rates
        async with Session() as s, s.begin():
            await s.execute(delete(Device))
        await engine.dispose()

    asyncio.run(scenario())
