"""Alerty na danych z agenta: kontener zatrzymany, usługa nie działa, SMART, temperatura (tabela `metrics`).

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
from sqlalchemy import delete, insert, select  # noqa: E402

from netpulse.alerts import AlertEngine, matches, subject_key  # noqa: E402
from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Alert, AlertRule, Device, Metric, User  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
NOW = datetime.now(UTC).replace(microsecond=0)
STEP = 30  # interwał kolektora w testach (domyślny)


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
        await s.execute(delete(Device))


@pytest.fixture
def device():
    run(_reset)

    async def go():
        async with Session() as s, s.begin():
            d = Device(name="NAS", host="nas-alerty", port=0, driver="agent", kind="server", status="up", community=None)
            s.add(d)
            await s.flush()
            return d.id

    yield run(go)
    run(_reset)


def samples(dev_id: int, name: str, key: str, values: list[float], end: datetime = NOW):
    """Próbki co 30 s kończące się w `end` (ostatnia wartość = najnowsza)."""

    async def go():
        async with Session() as s, s.begin():
            n = len(values)
            await s.execute(
                insert(Metric),
                [
                    {"time": end - timedelta(seconds=STEP * (n - 1 - i)), "device_id": dev_id, "name": name, "key": key, "value": v}
                    for i, v in enumerate(values)
                ],
            )

    run(go)


def rule(**kw) -> int:
    async def go():
        async with Session() as s, s.begin():
            r = AlertRule(**{"name": kw.get("kind", "r"), "severity": "warning", "duration_s": 0, **kw})
            s.add(r)
            await s.flush()
            return r.id

    return run(go)


def evaluate(now=NOW) -> list[str]:
    async def go():
        await AlertEngine(now_fn=lambda: now).evaluate()
        async with Session() as s:
            return sorted(a.title for a in (await s.scalars(select(Alert).where(Alert.state == "firing"))).all())

    return run(go)


def test_matches_and_subject():
    assert matches(None, "anything")
    assert matches("nextcloud*", "nextcloud-db")
    assert matches("NGINX", "nginx.service")
    assert not matches("nginx", "nginx-proxy")
    assert subject_key("d1", "a" * 100).startswith("d1:#") and len(subject_key("d1", "a" * 100)) <= 64


def test_container_stopped_only_after_it_was_running(device):
    rule(kind="container_stopped", duration_s=60)
    samples(device, "container_up", "web", [1, 1, 0, 0, 0])  # działał, od 90 s stoi
    samples(device, "container_up", "backup-job", [0, 0, 0, 0, 0])  # od dawna zatrzymany (zadanie jednorazowe)
    samples(device, "container_up", "db", [1, 1, 1, 1, 1])
    assert evaluate() == ["NAS: kontener web zatrzymany"]
    # Dalej stoi: alert trwa, chociaż w oknie nie widać już, że działał
    samples(device, "container_up", "web", [0, 0, 0, 0, 0, 0], end=NOW + timedelta(minutes=5))
    samples(device, "container_up", "db", [1] * 6, end=NOW + timedelta(minutes=5))
    assert evaluate(NOW + timedelta(minutes=5)) == ["NAS: kontener web zatrzymany"]
    # Wrócił – alert się kończy
    samples(device, "container_up", "web", [1], end=NOW + timedelta(minutes=5, seconds=30))
    assert evaluate(NOW + timedelta(minutes=5, seconds=30)) == []


def test_container_rule_with_name_alerts_even_if_long_stopped(device):
    rule(kind="container_stopped", duration_s=0, match="backup*")
    samples(device, "container_up", "backup-job", [0, 0, 0])
    samples(device, "container_up", "web", [1, 0, 0])
    assert evaluate() == ["NAS: kontener backup-job zatrzymany"]


def test_service_failed_and_smart(device):
    rule(kind="service_failed", duration_s=60)
    rule(kind="smart_failed")
    samples(device, "service_up", "backup.service", [0, 0, 0, 0])
    samples(device, "service_up", "nginx.service", [1, 1, 0])  # dopiero 30 s – za krótko
    samples(device, "smart_ok", "sda", [1, 1, 0])
    samples(device, "smart_ok", "sdb", [1, 1, 1])
    assert evaluate() == ["NAS: dysk sda zgłasza błąd SMART", "NAS: usługa backup nie działa"]


def test_temperature_threshold_per_sensor(device):
    rule(kind="metric", metric="temp_c", op=">", threshold=80.0, duration_s=60)
    samples(device, "temp_c", "coretemp/Package id 0", [82, 85, 88, 90])
    samples(device, "temp_c", "nvme/Composite", [40, 41, 42, 42])
    samples(device, "temp_c", "acpitz/temp1", [70, 70, 81])  # przekroczenie za krótko
    assert evaluate() == ["NAS: temperatura coretemp/Package id 0 90,0°C"]


def test_rules_api_accepts_agent_kinds():
    run(_reset)
    login_limiter._failures.clear()

    async def clear_users():
        async with Session() as s, s.begin():
            await s.execute(delete(User))

    run(clear_users)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        res = c.post("/api/alert-rules", json={"name": "Kontenery", "kind": "container_stopped", "duration_s": 60, "match": " nextcloud* "})
        assert res.status_code == 201 and res.json()["match"] == "nextcloud*"
        res = c.post("/api/alert-rules", json={"name": "Offline", "kind": "device_offline", "match": "x"})
        assert res.status_code == 201 and res.json()["match"] is None
        res = c.post("/api/alert-rules", json={"name": "CPU", "kind": "metric", "metric": "cpu_percent", "op": ">", "threshold": 90, "match": "x"})
        assert res.json()["match"] is None
        res = c.post("/api/alert-rules", json={"name": "Temp", "kind": "metric", "metric": "temp_c", "op": ">", "threshold": 80, "match": "coretemp*"})
        assert res.json()["match"] == "coretemp*"
        metrics = {m["metric"]: m for m in c.get("/api/alert-rules/metrics").json()}
        assert metrics["temp_c"]["matchable"] and metrics["temp_c"]["per_device"] and not metrics["cpu_percent"]["matchable"]
    run(clear_users)
