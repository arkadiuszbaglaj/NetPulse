"""Raport miesięczny na prawdziwej bazie: dostępność z agregatów, ruch i SLA WAN, sprawdzenia, alerty, API CSV/PDF.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import csv
import io
import os
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from netpulse import report as rp  # noqa: E402
from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.config import settings  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import (  # noqa: E402
    Alert,
    Check,
    CheckMetric,
    Device,
    DeviceMetric,
    Interface,
    InterfaceMetric,
    User,
    WanLink,
    WanLinkMetric,
)

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
NOW = datetime.now(UTC).replace(microsecond=0)
T0 = NOW - timedelta(hours=3)  # próbki: godzina od T0, co 30 s
LOCAL = T0.astimezone(ZoneInfo(settings.timezone))
MONTH = f"{LOCAL.year}-{LOCAL.month:02d}"
STEPS = 120


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
        await s.execute(delete(Alert))
        await s.execute(delete(Check))
        await s.execute(delete(Device))
        await s.execute(delete(User))


async def _seed():
    async with Session() as s, s.begin():
        gw = Device(name="UCG Ultra", host="192.168.1.1", community="public", kind="gateway")
        off = Device(name="Stary AP", host="192.168.1.9", community="public", enabled=False)  # wyłączony, bez danych – pomijany
        s.add_all([gw, off])
        await s.flush()
        wan = Interface(device_id=gw.id, if_index=5, name="eth4", label="WAN", role="wan")
        s.add(wan)
        await s.flush()
        link = WanLink(device_id=gw.id, interface_id=wan.id, position=1, name="Światłowód")
        chk = Check(name="Internet", kind="ping", target="8.8.8.8", interval_s=30)
        s.add_all([link, chk])
        await s.flush()
        for i in range(STEPS):
            t = T0 + timedelta(seconds=30 * i)
            ok = i < STEPS - 6  # ostatnie 6 próbek: urządzenie nie odpowiada, łącze i ping leżą
            s.add(DeviceMetric(time=t, device_id=gw.id, reachable=ok))
            s.add(InterfaceMetric(time=t, interface_id=wan.id, in_bps=8e6, out_bps=8e5, oper_up=True))
            s.add(WanLinkMetric(time=t, wan_link_id=link.id, up=ok, active=ok))
            s.add(CheckMetric(time=t, check_id=chk.id, up=ok, latency_ms=12.0 if ok else None))
        s.add(Alert(subject=f"d{gw.id}", severity="critical", title="Urządzenie nie odpowiada", device_id=gw.id,
                    started_at=T0 + timedelta(minutes=57), resolved_at=T0 + timedelta(minutes=60)))  # fmt: skip
        s.add(Alert(subject=f"d{gw.id}", severity="warning", title="Stary alert", device_id=gw.id,
                    started_at=T0 - timedelta(days=40), resolved_at=T0 - timedelta(days=40) + timedelta(minutes=5)))  # fmt: skip


@pytest.fixture
def client():
    login_limiter._failures.clear()
    run(_reset)
    run(_seed)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(_reset)


def test_monthly_report_json(client):
    r = client.get(f"/api/reports/monthly?month={MONTH}")
    assert r.status_code == 200, r.text
    data = r.json()
    assert (data["year"], data["month"]) == (LOCAL.year, LOCAL.month)
    (dev,) = data["devices"]  # wyłączony AP bez danych pominięty
    assert dev["name"] == "UCG Ultra" and dev["samples"] == STEPS
    assert dev["percent"] == pytest.approx(95.0)
    assert dev["down_s"] == 6 * settings.poll_interval
    (chk,) = data["checks"]
    assert chk["percent"] == pytest.approx(95.0) and chk["failed"] == 6 and chk["avg_latency_ms"] == pytest.approx(12.0)
    (wan,) = data["wan"]
    assert wan["name"] == "Światłowód" and wan["device"] == "UCG Ultra"
    assert wan["rx_bytes"] > 0 and wan["rx_bytes"] == pytest.approx(wan["tx_bytes"] * 10)
    assert wan["percent"] is not None and 90 < wan["percent"] < 100 and wan["outages"] == 1
    assert data["alerts_total"] == 1 and data["alerts"][0]["title"] == "Urządzenie nie odpowiada"
    assert data["alerts"][0]["duration_s"] == pytest.approx(180)
    assert data["alerts_by_severity"] == {"critical": 1}
    assert data["devices_percent"] == pytest.approx(95.0)


def test_monthly_report_downloads(client):
    r = client.get(f"/api/reports/monthly.csv?month={MONTH}")
    assert r.status_code == 200
    assert r.headers["content-disposition"] == f'attachment; filename="uplinkview-raport-{MONTH}.csv"'
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig")), delimiter=";"))
    assert any(row[:4] == ["UCG Ultra", "192.168.1.1", "router", "95,000"] for row in rows)

    r = client.get(f"/api/reports/monthly.pdf?month={MONTH}")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF-")


def test_month_validation_and_login(client):
    assert client.get("/api/reports/monthly?month=2026-1").status_code == 422
    assert client.get("/api/reports/monthly?month=2999-01").status_code == 422
    assert client.get("/api/reports/monthly").status_code == 200  # poprzedni miesiąc
    client.post("/api/auth/logout")
    assert client.get(f"/api/reports/monthly.pdf?month={MONTH}").status_code == 401


def test_build_directly_matches_api(client):
    year, month = rp.parse_month(MONTH)
    report = run(lambda: rp.build(year, month))
    assert report.title == f"{rp.MONTHS[month - 1]} {year}"
    assert [d.name for d in report.devices] == ["UCG Ultra"]
