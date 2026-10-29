"""Zdarzenia na osi czasu wykresów (adnotacje) na prawdziwej bazie: alerty, restarty urządzeń, przełączenia WAN.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Alert, Device, DeviceMetric, Interface, User, WanLink, WanLinkMetric  # noqa: E402

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
        await s.execute(delete(Alert))
        await s.execute(delete(Device))
        await s.execute(delete(User))


@pytest.fixture
def client():
    login_limiter._failures.clear()
    run(init_db)
    run(_clean)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(_clean)


def test_events_alerts_restarts_and_wan_switch(client):
    now = datetime.now(UTC).replace(microsecond=0)
    ago = lambda m: now - timedelta(minutes=m)  # noqa: E731

    async def seed():
        async with Session() as s, s.begin():
            sw = Device(name="USW", host="10.0.0.2", community="public", kind="switch")
            gw = Device(name="UCG", host="10.0.0.1", community="public", kind="gateway")
            s.add_all([sw, gw])
            await s.flush()
            # Switch: uptime rośnie, o 30 min temu spada do 120 s – restart 2 minuty wcześniej
            for m, uptime in ((50, 9000), (40, 9600), (30, 120), (20, 720)):
                s.add(DeviceMetric(time=ago(m), device_id=sw.id, reachable=True, uptime_s=uptime))
            # Alert o porcie: zaczął się i skończył w oknie; stary alert (sprzed okna) – pominięty
            s.add(Alert(subject="i15", state="resolved", severity="critical", title="USW: port 7 nie działa", device_id=sw.id, started_at=ago(25), resolved_at=ago(10)))
            s.add(Alert(subject="wan", state="resolved", severity="warning", title="Stary alert", started_at=ago(500), resolved_at=ago(400)))
            # Dwa łącza WAN: ruch przechodzi z WAN 1 na WAN 2 o 15 min temu
            ports = [Interface(device_id=gw.id, if_index=i, name=f"eth{i}") for i in (4, 3)]
            s.add_all(ports)
            await s.flush()
            links = [WanLink(device_id=gw.id, interface_id=p.id, position=n, name=f"WAN {n}") for n, p in enumerate(ports, 1)]
            s.add_all(links)
            await s.flush()
            for m in (20, 15):
                s.add(WanLinkMetric(time=ago(m), wan_link_id=links[0].id, up=m == 20, active=m == 20))
                s.add(WanLinkMetric(time=ago(m), wan_link_id=links[1].id, up=True, active=m == 15))
            return sw.id, gw.id

    sw_id, gw_id = run(seed)
    res = client.get("/api/events", params={"minutes": 60})
    assert res.status_code == 200, res.text
    events = [(e["kind"], e["title"], e["device_id"], e["interface_id"], e["severity"]) for e in res.json()]
    assert events == [
        ("restart", "USW", sw_id, None, None),
        ("alert", "USW: port 7 nie działa", sw_id, 15, "critical"),
        ("wan_switch", "WAN 1 → WAN 2", gw_id, None, None),
        ("alert_end", "USW: port 7 nie działa", sw_id, 15, "critical"),
    ]
    restart = datetime.fromisoformat(res.json()[0]["time"])
    assert restart == ago(32)

    # Okno przesunięte wstecz (powiększony fragment): tylko to, co w nim
    old = client.get("/api/events", params={"minutes": 30, "offset": 390}).json()
    assert [(e["kind"], e["title"]) for e in old] == [("alert_end", "Stary alert")]
    with TestClient(app) as anon:
        assert anon.get("/api/events", params={"minutes": 60}).status_code == 401
