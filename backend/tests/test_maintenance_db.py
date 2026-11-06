"""Okna serwisowe na prawdziwej bazie: API, alerty bez powiadomień, dostępność bez czasu okna, znacznik urządzenia.

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
from sqlalchemy import delete, select  # noqa: E402

from netpulse.alerts import AlertEngine  # noqa: E402
from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.config import settings  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Alert, AlertRule, AppSetting, Device, DeviceMetric, MaintenanceWindow, User  # noqa: E402

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
        await s.execute(delete(MaintenanceWindow))
        await s.execute(delete(Alert))
        await s.execute(delete(AlertRule))
        await s.execute(delete(AppSetting).where(AppSetting.key == "alert_defaults"))
        await s.execute(delete(Device))
        await s.execute(delete(User))


@pytest.fixture
def lab():
    """Zalogowany klient i dwa urządzenia: switch (nie odpowiada) i AP (działa)."""
    login_limiter._failures.clear()
    now = datetime.now(UTC)

    async def go():
        await _reset()
        async with Session() as s, s.begin():
            sw = Device(
                name="USW", host="10.8.0.2", community="x", kind="switch", status="down", last_polled_at=now,
                last_ok_at=now - timedelta(minutes=10), last_error="timeout",
            )  # fmt: skip
            ap = Device(name="U6+", host="10.8.0.3", community="x", kind="ap", status="up", last_polled_at=now, last_ok_at=now)
            s.add_all([sw, ap])
            await s.flush()
            # Switch: 4 odczyty, ten sprzed 2 min bez odpowiedzi
            for minutes, ok in ((4, True), (3, True), (2, False), (1, True)):
                s.add(DeviceMetric(time=now - timedelta(minutes=minutes), device_id=sw.id, reachable=ok))
            return sw.id, ap.id

    ids = run(go)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c, ids
    run(_reset)


def iso(dt: datetime) -> str:
    return dt.isoformat()


def once(device_ids, start: datetime, end: datetime, name="Firmware") -> dict:
    return {"name": name, "kind": "once", "device_ids": device_ids, "starts_at": iso(start), "ends_at": iso(end)}


def test_crud_and_validation(lab):
    client, (sw, _ap) = lab
    now = datetime.now(UTC)
    bad = [
        {"name": "x", "kind": "once", "starts_at": iso(now), "ends_at": iso(now - timedelta(hours=1))},
        {"name": "x", "kind": "once", "starts_at": iso(now), "ends_at": iso(now + timedelta(days=40))},
        {"name": "x", "kind": "weekly", "days": [], "time_from": "02:00", "duration_min": 60},
        {"name": "x", "kind": "weekly", "days": [7], "time_from": "02:00", "duration_min": 60},
        {"name": "x", "kind": "weekly", "days": [1], "time_from": "25:00", "duration_min": 60},
        {"name": " ", "kind": "weekly", "days": [1], "time_from": "02:00", "duration_min": 60},
    ]
    for body in bad:
        assert client.post("/api/maintenance", json=body).status_code == 422, body
    assert client.post("/api/maintenance", json=once([999999], now, now + timedelta(hours=1))).status_code == 422

    res = client.post("/api/maintenance", json=once([sw, sw], now - timedelta(minutes=5), now + timedelta(hours=1)))
    assert res.status_code == 201, res.text
    w = res.json()
    assert w["device_ids"] == [sw] and w["active"] is True and w["active_until"] and w["days"] == []

    # Pola innego rodzaju okna są czyszczone
    weekly = {"name": "Nocny restart", "kind": "weekly", "days": [6, 0, 6], "time_from": "03:00", "duration_min": 30, "starts_at": iso(now)}
    res = client.put(f"/api/maintenance/{w['id']}", json=weekly)
    assert res.status_code == 200, res.text
    assert res.json()["days"] == [0, 6] and res.json()["starts_at"] is None and res.json()["next_start"]
    assert [x["name"] for x in client.get("/api/maintenance").json()] == ["Nocny restart"]

    assert client.delete(f"/api/maintenance/{w['id']}").status_code == 204
    assert client.delete(f"/api/maintenance/{w['id']}").status_code == 404
    assert client.put(f"/api/maintenance/{w['id']}", json=weekly).status_code == 404


def test_devices_show_maintenance(lab):
    client, (sw, ap) = lab
    now = datetime.now(UTC)
    client.post("/api/maintenance", json=once([sw], now - timedelta(minutes=5), now + timedelta(hours=1)))
    flags = {d["id"]: d["maintenance"] for d in client.get("/api/devices").json()}
    assert flags == {sw: True, ap: False}
    assert client.get(f"/api/devices/{ap}").json()["maintenance"] is False

    client.post("/api/maintenance", json=once([], now - timedelta(minutes=5), now + timedelta(hours=1), name="Prąd"))
    assert all(d["maintenance"] for d in client.get("/api/devices").json())  # okno na wszystko


def test_alert_in_window_is_silent_and_notifies_after(lab):
    client, (sw, _ap) = lab
    now = datetime.now(UTC)

    async def rule():
        async with Session() as s, s.begin():
            s.add(AlertRule(name="offline", kind="device_offline", duration_s=0, severity="critical", enabled=True))

    def evaluate():
        return run(lambda: AlertEngine(now_fn=lambda: datetime.now(UTC)).evaluate())

    run(rule)
    window = client.post("/api/maintenance", json=once([sw], now - timedelta(minutes=5), now + timedelta(hours=1))).json()
    assert evaluate() == []  # alert jest, ale bez powiadomienia
    (a,) = client.get("/api/alerts", params={"state": "all"}).json()
    assert a["state"] == "firing" and a["maintenance"] is True
    summary = client.get("/api/alerts/summary").json()
    assert summary["firing"] == 1 and summary["unacked"] == 0  # dzwonek się nie zapala

    assert client.delete(f"/api/maintenance/{window['id']}").status_code == 204  # okno minęło, a switch dalej leży
    events = evaluate()
    assert [(e.kind, e.title) for e in events] == [("firing", "USW nie odpowiada")]
    (a,) = client.get("/api/alerts", params={"state": "all"}).json()
    assert a["maintenance"] is False and client.get("/api/alerts/summary").json()["unacked"] == 1

    async def muted():
        async with Session() as s:
            return (await s.scalars(select(Alert))).one().muted

    assert run(muted) is False


def test_availability_skips_window(lab):
    client, (sw, _ap) = lab
    now = datetime.now(UTC)
    before = client.get(f"/api/devices/{sw}/availability", params={"days": 1}).json()
    assert before["samples"] == 4 and before["percent"] == pytest.approx(75.0) and before["maintenance_s"] == 0

    # Okno obejmuje tylko odczyt sprzed 2 min (ten bez odpowiedzi)
    window = once([sw], now - timedelta(minutes=2, seconds=30), now - timedelta(minutes=1, seconds=30))
    assert client.post("/api/maintenance", json=window).status_code == 201
    after = client.get(f"/api/devices/{sw}/availability", params={"days": 1}).json()
    assert after["samples"] == 3 and after["percent"] == pytest.approx(100.0) and after["down_s"] == 0
    assert after["maintenance_s"] == settings.poll_interval
    assert sum(d["samples"] for d in after["daily"]) == 3
    listed = {x["device_id"]: x for x in client.get("/api/availability", params={"days": 1}).json()}
    assert listed[sw]["percent"] == pytest.approx(100.0) and listed[sw]["samples"] == 3
