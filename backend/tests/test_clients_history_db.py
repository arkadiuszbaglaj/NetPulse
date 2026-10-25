"""Historia klientów sieci na prawdziwej bazie: zapis z kolektora UniFi i API strony klienta.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import UTC, datetime, timedelta

import pytest
from conftest import FIXTURES

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete, func, select  # noqa: E402

from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.config import settings  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import ClientMetric, Controller, Device, KnownClient, NetworkClient, User  # noqa: E402
from netpulse.unifi import parse_clients, parse_devices  # noqa: E402
from netpulse.unifi_collector import UnifiCollector  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
MAC = "02:00:00:00:aa:01"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeApi:
    def __init__(self, clients: dict | None = None) -> None:
        self._clients = clients or fixture("unifi_clients.json")

    async def app_version(self):
        return "10.6.109"

    async def devices(self):
        return parse_devices(fixture("unifi_devices.json"))

    async def clients(self):
        return parse_clients(self._clients)

    async def close(self):
        pass


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


async def _clean():
    async with Session() as s, s.begin():
        await s.execute(delete(Controller))
        await s.execute(delete(Device))
        await s.execute(delete(User))
        await s.execute(delete(KnownClient))
        await s.execute(delete(ClientMetric))


@pytest.fixture
def client():
    login_limiter._failures.clear()

    async def go():
        await init_db()
        await _clean()
        async with Session() as s, s.begin():
            s.add(Controller(name="UniFi", host="10.0.0.254", api_key="klucz-testowy-123"))

    run(go)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(_clean)


def poll(api: FakeApi) -> None:
    async def go():
        collector = UnifiCollector(api_factory=lambda _t: api)
        (target,) = await collector.load_targets()
        return await collector.poll_one(target)

    assert run(go) is True


def test_collector_keeps_history_and_known_clients(client):
    poll(FakeApi())
    fewer = fixture("unifi_clients.json")
    fewer["data"] = fewer["data"][:2]
    poll(FakeApi(clients=fewer))

    async def counts():
        async with Session() as s:
            return (
                await s.scalar(select(func.count()).select_from(NetworkClient)),
                await s.scalar(select(func.count()).select_from(KnownClient)),
                await s.scalar(select(func.count()).select_from(ClientMetric)),
            )

    online, known, samples = run(counts)
    assert (online, known) == (2, 9)  # rozłączeni znikają z listy, ale zostają jako znani klienci
    assert samples == 9 + 2

    mac = fixture("unifi_clients.json")["data"][5]["mac"]  # ten klient zniknął w drugim odczycie
    detail = client.get(f"/api/clients/{mac}").json()
    assert detail["online"] is False and detail["current"] is None and detail["name"]
    online_mac = fewer["data"][0]["mac"]
    detail = client.get(f"/api/clients/{online_mac.upper()}").json()  # wielkość liter w MAC bez znaczenia
    assert detail["online"] is True and detail["current"]["mac"] == online_mac


def seed_history():
    """Klient WiFi: AP 1 na 5 GHz, przejście na AP 2, przerwa 10 min, powrót na 2,4 GHz."""
    now = datetime.now(UTC)
    step = timedelta(seconds=settings.poll_interval)

    async def go():
        async with Session() as s, s.begin():
            s.add(KnownClient(mac=MAC, name="Telefon", is_wired=False, is_guest=False, first_seen_at=now - timedelta(hours=1), last_seen_at=now))
            t = now - timedelta(minutes=40)
            plan = [(1, "AP Salon", "na", -50)] * 3 + [(2, "AP Biuro", "na", -60)] * 3
            for dev, name, radio, signal in plan:
                s.add(ClientMetric(time=t, mac=MAC, signal_dbm=signal, rx_rate_kbps=866000, tx_rate_kbps=650000,
                                   uplink_device_id=dev, uplink_name=name, essid="Dom", radio=radio))
                t += step
            t += timedelta(minutes=10)
            s.add(ClientMetric(time=t, mac=MAC, signal_dbm=-70, uplink_device_id=2, uplink_name="AP Biuro", essid="Dom", radio="ng"))
            s.add(ClientMetric(time=t + step, mac=MAC, signal_dbm=-71, uplink_device_id=2, uplink_name="AP Biuro", essid="Dom", radio="ng"))

    run(go)


def test_client_metrics_presence_and_events(client):
    seed_history()
    metrics = client.get(f"/api/clients/{MAC}/metrics", params={"minutes": 60}).json()
    signals = [p["values"]["signal_dbm"] for p in metrics if p["values"]["signal_dbm"] is not None]
    assert min(signals) <= -70 and max(signals) >= -55

    presence = client.get(f"/api/clients/{MAC}/presence", params={"minutes": 60}).json()
    assert presence["interval_s"] == 30 and presence["expected"] == 30 / settings.poll_interval
    assert sum(b["samples"] for b in presence["buckets"]) == 8

    events = client.get(f"/api/clients/{MAC}/events", params={"minutes": 60}).json()
    kinds = [e["kind"] for e in reversed(events)]  # API: od najnowszych
    assert kinds == ["connect", "roam", "connect"]
    assert events[-1]["gap_s"] is None and events[-1]["uplink_name"] == "AP Salon"
    assert events[1]["uplink_name"] == "AP Biuro"
    assert events[0]["gap_s"] >= 600 and events[0]["radio"] == "ng"


def test_unknown_client_and_bad_mac(client):
    assert client.get("/api/clients/02:00:00:00:ff:ff").status_code == 404
    assert client.get("/api/clients/nie-mac").status_code == 422
    client.post("/api/auth/logout")
    assert client.get(f"/api/clients/{MAC}").status_code == 401
