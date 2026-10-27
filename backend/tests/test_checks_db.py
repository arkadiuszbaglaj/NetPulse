"""Sprawdzanie dostępności na prawdziwej bazie: kolektor, API, alerty, kolekcja i oś stanów.

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
from netpulse.api import checks as checks_api  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.checks import CheckResult  # noqa: E402
from netpulse.checks_collector import ChecksCollector, save_result  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Alert, AlertRule, AppSetting, Check, CheckMetric, Device, User  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
NOW = datetime.now(UTC).replace(microsecond=0)
PING = {"name": "Internet", "kind": "ping", "target": "8.8.8.8", "interval_s": 30, "timeout_s": 3}


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
        await s.execute(delete(AlertRule))
        await s.execute(delete(AppSetting).where(AppSetting.key == "alert_defaults"))
        await s.execute(delete(Check))
        await s.execute(delete(Device))
        await s.execute(delete(User))


@pytest.fixture
def client():
    login_limiter._failures.clear()
    run(_reset)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(_reset)


def add_metrics(check_id: int, rows: list[dict], step_s: int = 30):
    """Wyniki od najstarszego, ostatni = teraz."""

    async def go():
        async with Session() as s, s.begin():
            n = len(rows)
            s.add_all(CheckMetric(time=NOW - timedelta(seconds=step_s * (n - 1 - i)), check_id=check_id, **r) for i, r in enumerate(rows))

    run(go)


def test_crud_test_endpoint_and_validation(client, monkeypatch):
    res = client.post("/api/checks", json=PING)
    assert res.status_code == 201, res.text
    created = res.json()
    assert created["status"] == "unknown" and created["port"] is None and created["enabled"] is True
    assert client.post("/api/checks", json={**PING, "kind": "http", "target": "ftp://x"}).status_code == 422
    assert client.post("/api/checks", json={**PING, "kind": "tcp"}).status_code == 422  # brak portu

    updated = client.put(f"/api/checks/{created['id']}", json={**PING, "name": "Internet – Google", "interval_s": 60}).json()
    assert updated["name"] == "Internet – Google" and updated["interval_s"] == 60
    assert client.put("/api/checks/999999", json=PING).status_code == 404

    async def fake(kind, target, **kw):
        return CheckResult(up=True, latency_ms=14.2, loss_percent=0.0, jitter_ms=0.4)

    monkeypatch.setattr(checks_api, "run_check", fake)
    test = client.post("/api/checks/test", json=PING).json()
    assert test == {"up": True, "latency_ms": 14.2, "loss_percent": 0.0, "jitter_ms": 0.4, "status_code": None, "cert_days": None, "error": None}

    assert client.delete(f"/api/checks/{created['id']}").status_code == 204
    assert client.get("/api/checks").json() == []
    assert client.delete(f"/api/checks/{created['id']}").status_code == 404


def test_collector_runs_due_checks_and_tracks_status(client):
    ids = [client.post("/api/checks", json={**PING, "name": n, "interval_s": i}).json()["id"] for n, i in (("A", 30), ("B", 300))]
    results = {"8.8.8.8": [CheckResult(up=True, latency_ms=15.0, loss_percent=0.0, jitter_ms=0.5)]}
    calls = []

    async def runner(kind, target, **kw):
        calls.append(target)
        return results[target][-1]

    collector = ChecksCollector(runner=runner)
    assert run(lambda: collector.tick(now_mono=1000.0)) == 2
    assert run(lambda: collector.tick(now_mono=1010.0)) == 0  # za wcześnie dla obu
    assert run(lambda: collector.tick(now_mono=1031.0)) == 1  # A co 30 s, B co 5 min
    results["8.8.8.8"].append(CheckResult(up=False, loss_percent=100.0, error="Brak odpowiedzi na ping"))
    assert run(lambda: collector.tick(now_mono=1062.0)) == 1

    listed = {c["name"]: c for c in client.get("/api/checks").json()}
    a, b = listed["A"], listed["B"]
    assert a["status"] == "down" and a["last_error"] == "Brak odpowiedzi na ping" and a["loss_percent"] == 100.0
    assert a["availability_24h"] == pytest.approx(66.67, abs=0.01)
    assert b["status"] == "up" and b["last_latency_ms"] == 15.0 and b["availability_24h"] == 100.0 and b["jitter_ms"] == 0.5
    series = client.get(f"/api/checks/{ids[0]}/metrics", params={"minutes": 60}).json()
    assert series and {"latency_ms", "loss_percent", "jitter_ms", "availability_percent", "cert_days"} <= set(series[-1]["values"])


def test_alerts_check_down_latency_and_certificate(client):
    ping = client.post("/api/checks", json=PING).json()["id"]
    web = client.post("/api/checks", json={"name": "Strona", "kind": "http", "target": "https://example.com", "interval_s": 60, "timeout_s": 5}).json()["id"]
    run(lambda: save_result(ping, CheckResult(up=False, error="Brak odpowiedzi na ping"), NOW - timedelta(minutes=10)))  # przed oknem reguły opóźnienia
    add_metrics(ping, [{"up": True, "latency_ms": 180.0, "loss_percent": 0.0}] * 12)
    add_metrics(web, [{"up": True, "latency_ms": 90.0, "status_code": 200, "cert_days": 9.5}], step_s=60)
    for rule in (
        {"name": "Nie działa", "kind": "check_down", "duration_s": 120, "match": "Inter*"},
        {"name": "Opóźnienie", "kind": "metric", "metric": "check_latency_ms", "op": ">", "threshold": 100, "duration_s": 300},
        {"name": "Certyfikat", "kind": "metric", "metric": "check_cert_days", "op": "<", "threshold": 14, "duration_s": 0},
    ):
        assert client.post("/api/alert-rules", json=rule).status_code == 201, rule
    assert client.post("/api/alert-rules", json={"name": "x", "kind": "check_down", "device_id": 1}).status_code == 422

    async def evaluate():
        await AlertEngine(now_fn=lambda: NOW).evaluate()
        async with Session() as s:
            return sorted(a.title for a in (await s.scalars(select(Alert).where(Alert.state == "firing"))).all())

    assert run(evaluate) == ["Internet: niedostępne", "Internet: opóźnienie 180,0 ms", "Strona: certyfikat wygasa za 9,5 dni"]


def test_collection_states_and_public_dashboard(client):
    cid = client.post("/api/checks", json=PING).json()["id"]
    client.post("/api/checks", json={**PING, "name": "Wyłączone", "enabled": False})
    add_metrics(cid, [{"up": True, "latency_ms": 12.0, "loss_percent": 0.0}] * 3 + [{"up": False, "loss_percent": 100.0}])
    run(lambda: save_result(cid, CheckResult(up=False, loss_percent=100.0, error="x"), NOW + timedelta(seconds=1)))

    rows = client.get("/api/collections/checks").json()["rows"]
    assert [r["label"] for r in rows] == ["Internet"]  # wyłączone pomijamy, adresu celu nie ma
    assert rows[0]["values"]["up"] == 0.0 and rows[0]["values"]["loss_percent"] == 100.0 and "8.8.8.8" not in str(rows)
    states = client.get("/api/states", params={"checks": str(cid), "minutes": 15}).json()
    (item,) = states["items"]
    assert item["kind"] == "check" and item["label"] == "Internet" and item["segments"][-1]["state"] == "down"

    layout = {"version": 1, "widgets": [
        {"id": "c", "type": "chart", "w": 6, "config": {"queries": [{"id": "A", "source": {"kind": "check", "id": cid}, "series": [{"key": "latency_ms"}]}]}},
        {"id": "t", "type": "table", "w": 6, "config": {"collection": {"kind": "checks"}, "columns": ["up", "latency_ms"]}},
        {"id": "s", "type": "state_timeline", "w": 12, "config": {"items": [{"kind": "check", "id": cid}]}},
    ]}  # fmt: skip
    dash = client.post("/api/dashboards", json={"name": "Publiczny", "layout": layout}).json()
    token = client.put(f"/api/dashboards/{dash['id']}/public", json={"enabled": True}).json()["public"]["token"]
    with TestClient(app) as tv:  # bez sesji – jak wyświetlacz na ścianie

        def data(path):
            return tv.get(f"/api/public/dashboards/{token}/data", params={"path": path})

        assert data(f"/api/checks/{cid}/metrics?minutes=60").status_code == 200
        assert data("/api/collections/checks").status_code == 200
        assert data(f"/api/states?checks={cid}&minutes=60").status_code == 200
        assert data(f"/api/checks/{cid + 1}/metrics?minutes=60").status_code == 403
