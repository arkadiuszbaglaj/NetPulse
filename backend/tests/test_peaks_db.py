"""Szczyt ruchu WAN i testy prędkości bramy na prawdziwej bazie (od 0.70.0): zapis, API wykresów, próbnik.

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
from sqlalchemy import delete, func, select  # noqa: E402

from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Device, Interface, InterfaceMetric, Metric, User  # noqa: E402
from netpulse.peaks import PeakSampler  # noqa: E402
from netpulse.snmp import oids as O  # noqa: E402
from netpulse.unifi import Speedtest  # noqa: E402
from netpulse.unifi_collector import save_speedtest  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
MBPS = 1_000_000


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


@pytest.fixture
def gateway():
    """Brama z portem WAN (eth4) i portem LAN; zwraca (id urządzenia, id portu WAN, id portu LAN)."""
    login_limiter._failures.clear()

    async def go():
        await _reset()
        async with Session() as s, s.begin():
            dev = Device(name="UCG Ultra", host="10.0.0.1", community="public", kind="gateway", status="up")
            s.add(dev)
            await s.flush()
            wan = Interface(device_id=dev.id, if_index=5, name="eth4", label="WAN", role="wan", oper_status="up", speed_mbps=1000, if_type=6)
            lan = Interface(device_id=dev.id, if_index=1, name="eth0", label="LAN 1", role="lan", oper_status="up", speed_mbps=1000, if_type=6)
            s.add_all([wan, lan])
            await s.flush()
            return dev.id, wan.id, lan.id

    ids = run(go)
    yield ids
    run(_reset)


def test_traffic_and_port_charts_return_peak_next_to_average(gateway):
    dev_id, wan_id, _ = gateway

    async def seed():
        now = datetime.now(UTC)
        async with Session() as s, s.begin():
            # Trzy próbki z ostatnich minut: w środkowej test prędkości (średnia 106, szczyt 455 Mb/s)
            s.add(InterfaceMetric(time=now - timedelta(seconds=90), interface_id=wan_id, in_bps=2 * MBPS, out_bps=1 * MBPS, in_bps_max=3 * MBPS, out_bps_max=1 * MBPS, oper_up=True))
            s.add(InterfaceMetric(time=now - timedelta(seconds=60), interface_id=wan_id, in_bps=106 * MBPS, out_bps=17 * MBPS, in_bps_max=455 * MBPS, out_bps_max=51 * MBPS, oper_up=True))
            # Próbka sprzed 0.70.0 albo cykl bez pomiaru szczytu
            s.add(InterfaceMetric(time=now - timedelta(seconds=30), interface_id=wan_id, in_bps=4 * MBPS, out_bps=1 * MBPS, oper_up=True))

    run(seed)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        traffic = c.get("/api/dashboard/traffic", params={"minutes": 60}).json()["points"]
        assert max(p["values"]["in_bps_max"] or 0 for p in traffic) == 455 * MBPS
        assert max(p["values"]["out_bps_max"] or 0 for p in traffic) == 51 * MBPS
        assert max(p["values"]["in_bps"] or 0 for p in traffic) <= 106 * MBPS  # średnia nie udaje szczytu
        port = c.get(f"/api/interfaces/{wan_id}/metrics", params={"minutes": 60}).json()
        assert max(p["values"]["in_bps_max"] or 0 for p in port) == 455 * MBPS
        assert {"in_bps", "out_bps", "in_bps_max", "out_bps_max", "in_errors"} <= set(port[0]["values"])
        # Zakres 30 dni idzie z agregatu godzinowego: szczytu tam nie ma, serie są puste – bez błędu
        long = c.get(f"/api/interfaces/{wan_id}/metrics", params={"minutes": 43200})
        assert long.status_code == 200
        assert all(p["values"]["in_bps_max"] is None for p in long.json())
        long = c.get("/api/dashboard/traffic", params={"minutes": 43200})
        assert long.status_code == 200
        assert all(p["values"]["in_bps_max"] is None for p in long.json()["points"])


def test_day_chart_uses_five_minute_buckets_like_unifi(gateway):
    """Od 0.71.0: zakres 24 h = kubełki 5-minutowe o pełnych minutach; dziesięć próbek 30 s z jednego kubełka (zapisanych
    w środku swoich przedziałów) daje dokładnie średnią z bajtów tego kubełka – tak liczy UniFi."""
    _, wan_id, _ = gateway
    start = datetime.fromtimestamp((int(datetime.now(UTC).timestamp()) // 300 - 6) * 300, UTC)
    rates = [0.3, 0.3, 455.0, 0.4, 0.2, 0.3, 0.3, 0.2, 0.1, 0.1]  # Mb/s, w trzeciej części test prędkości

    async def seed():
        async with Session() as s, s.begin():
            for k, r in enumerate(rates):
                s.add(InterfaceMetric(time=start + timedelta(seconds=15 + 30 * k), interface_id=wan_id, in_bps=r * MBPS, out_bps=MBPS, oper_up=True))

    run(seed)
    expected = sum(rates) / len(rates) * MBPS  # = bajty z 5 minut × 8 / 300 s
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        port = {p["time"][:19]: p["values"] for p in c.get(f"/api/interfaces/{wan_id}/metrics", params={"minutes": 1440}).json()}
        assert list(port) == [start.strftime("%Y-%m-%dT%H:%M:%S")]
        assert abs(port[start.strftime("%Y-%m-%dT%H:%M:%S")]["in_bps"] - expected) < 1
        traffic = c.get("/api/dashboard/traffic", params={"minutes": 1440}).json()
        assert traffic["interval_s"] == 300
        (point,) = traffic["points"]
        assert point["time"][:19] == start.strftime("%Y-%m-%dT%H:%M:%S") and abs(point["values"]["in_bps"] - expected) < 1


def test_speedtest_is_saved_once_and_drawn_at_test_time(gateway):
    dev_id, _, _ = gateway
    ran = datetime.now(UTC) - timedelta(minutes=10)
    st = Speedtest("eth4", ran.timestamp(), 455.0, 51.0, 6.0, 17.0, "CRONEL.NET, Radomsko")

    async def save(test: Speedtest):
        async with Session() as s, s.begin():
            await save_speedtest(s, dev_id, test, datetime.now(UTC), 30)

    async def count() -> int:
        async with Session() as s:
            return await s.scalar(select(func.count()).select_from(Metric).where(Metric.device_id == dev_id, Metric.name.like("speedtest_%")))

    run(lambda: save(st))
    run(lambda: save(st))  # kolejne odczyty kontrolera zwracają ten sam ostatni test
    assert run(count) == 3
    # Nowy test – nowe punkty; test starszy niż retencja surowych danych jest pomijany
    run(lambda: save(Speedtest("eth4", ran.timestamp() + 300, 430.0, 50.0, None)))
    run(lambda: save(Speedtest("eth4", ran.timestamp() - 40 * 86400, 100.0, 10.0, 5.0)))
    assert run(count) == 5

    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        points = c.get(f"/api/devices/{dev_id}/agent-metrics", params={"source": "speedtest", "key": "eth4", "minutes": 60}).json()
        assert [p["values"]["down_bps"] for p in points] == [455 * MBPS, 430 * MBPS]
        assert [p["values"]["up_bps"] for p in points] == [51 * MBPS, 50 * MBPS]
        assert [p["values"]["ping_ms"] for p in points] == [6.0, None]
        # Łącze z testem jest do wyboru w edytorze wykresu, choć ostatni test był dawniej niż godzinę temu
        run(lambda: save(Speedtest("eth3", ran.timestamp() - 5 * 86400, 20.0, 5.0, 60.0)))
        assert c.get(f"/api/devices/{dev_id}/agent-keys").json()["speedtest"] == ["eth3", "eth4"]


class _Counters:
    """Atrapa klienta SNMP: liczniki portu WAN rosną z zadaną prędkością."""

    def __init__(self) -> None:
        self.octets = 0
        self.asked: list[list[str]] = []

    async def get(self, oids: list[str]) -> dict:
        self.asked.append(oids)
        return {oid: self.octets for oid in oids}

    async def close(self) -> None:
        pass


def test_sampler_reads_only_wan_ports_and_hands_peak_to_collector(gateway):
    dev_id, _, _ = gateway
    client = _Counters()
    sampler = PeakSampler(client_factory=lambda target: client, interval=1)

    async def go():
        targets = await sampler.load_targets()
        assert list(targets) == [dev_id]
        target, ports = targets[dev_id]
        assert [p.if_index for p in ports] == [5]  # tylko port z rolą WAN, bez LAN
        for second in range(12):
            client.octets = int(second * 200 * MBPS / 8)
            await sampler.sample_device(target, ports, float(second))
        assert client.asked[0] == [f"{O.IF_HC_IN_OCTETS}.5", f"{O.IF_HC_OUT_OCTETS}.5"]
        down, up = sampler.take(dev_id, 5)
        assert round(down / MBPS) == 200 and round(up / MBPS) == 200
        assert sampler.take(dev_id, 5) == (None, None)

    run(go)
