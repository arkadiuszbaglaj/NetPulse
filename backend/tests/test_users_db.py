"""Role kont i dziennik audytu na prawdziwej bazie (od 0.61.0).

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Alert, AuditEntry, Device, MaintenanceWindow, User  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
PASSWORD = "haslo-konta-123"


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
        await s.execute(delete(AuditEntry))
        await s.execute(delete(MaintenanceWindow))
        await s.execute(delete(Alert))
        await s.execute(delete(Device))
        await s.execute(delete(User))


@pytest.fixture
def admin():
    login_limiter._failures.clear()
    run(_reset)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(_reset)


def login(username: str, password: str = PASSWORD) -> TestClient:
    c = TestClient(app)
    assert c.post("/api/auth/login", json={"username": username, "password": password}).status_code == 200
    return c


def add_user(admin: TestClient, username: str, role: str) -> dict:
    res = admin.post("/api/users", json={"username": username, "password": PASSWORD, "role": role})
    assert res.status_code == 201, res.text
    return res.json()


def test_users_crud_and_last_admin_guard(admin):
    me = admin.get("/api/auth/me").json()
    assert me["role"] == "admin" and me["is_admin"] is True

    jan = add_user(admin, "jan", "operator")
    assert jan["role"] == "operator" and jan["is_admin"] is False
    assert admin.post("/api/users", json={"username": "JAN", "password": PASSWORD}).status_code == 409
    assert admin.post("/api/users", json={"username": "ola", "password": "krotkie"}).status_code == 422
    assert admin.post("/api/users", json={"username": "ola", "password": PASSWORD, "role": "root"}).status_code == 422
    assert [u["username"] for u in admin.get("/api/users").json()] == ["admin", "jan"]

    # Ostatni administrator: bez degradacji i usunięcia; własnego konta nie usuwamy
    assert admin.patch(f"/api/users/{me['id']}", json={"role": "viewer"}).status_code == 409
    assert admin.delete(f"/api/users/{me['id']}").status_code == 409

    jan_client = login("jan")
    assert admin.patch(f"/api/users/{jan['id']}", json={"role": "viewer"}).json()["role"] == "viewer"
    assert jan_client.get("/api/auth/me").status_code == 401  # nowa rola = nowe logowanie

    assert admin.patch(f"/api/users/{jan['id']}", json={"password": "nowe-haslo-456"}).status_code == 200
    login("jan", "nowe-haslo-456")
    assert admin.delete(f"/api/users/{jan['id']}").status_code == 204
    assert admin.delete(f"/api/users/{jan['id']}").status_code == 404


def test_viewer_reads_but_cannot_change(admin):
    add_user(admin, "widz", "viewer")
    viewer = login("widz")
    assert viewer.get("/api/devices").status_code == 200
    assert viewer.get("/api/alert-rules").status_code == 200
    denied = viewer.post("/api/devices?probe=false", json={"name": "SW", "host": "10.7.0.9", "community": "public"})
    assert denied.status_code == 403 and "administratora" in denied.json()["detail"]
    assert viewer.post("/api/maintenance", json={}).status_code == 403  # okna: od operatora
    assert viewer.get("/api/users").status_code == 403  # konta i dziennik tylko dla administratora
    assert viewer.get("/api/audit").status_code == 403
    assert viewer.get("/api/backups").status_code == 403
    # Własne ustawienia wolno
    assert viewer.put("/api/preferences/refresh", json={"interval_s": 30, "range_min": 60}).status_code == 200
    res = viewer.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "inne-haslo-789"})
    assert res.status_code == 204


def test_operator_acks_alerts_and_plans_maintenance(admin):
    add_user(admin, "op", "operator")
    operator = login("op")

    async def alert():
        from datetime import UTC, datetime

        async with Session() as s, s.begin():
            a = Alert(subject="d1", state="firing", severity="warning", title="Test", started_at=datetime.now(UTC))
            s.add(a)
            await s.flush()
            return a.id

    alert_id = run(alert)
    assert operator.post(f"/api/alerts/{alert_id}/ack").status_code == 200
    window = {"name": "Prace", "kind": "weekly", "days": [5], "time_from": "02:00", "duration_min": 60}
    created = operator.post("/api/maintenance", json=window)
    assert created.status_code == 201, created.text
    assert operator.delete(f"/api/maintenance/{created.json()['id']}").status_code == 204
    assert operator.post("/api/alert-rules", json={"name": "x", "kind": "device_offline"}).status_code == 403


def test_audit_log_records_logins_and_changes(admin):
    bad = TestClient(app).post("/api/auth/login", json={"username": "admin", "password": "zle-haslo-000"})
    assert bad.status_code == 401
    add_user(admin, "widz", "viewer")
    viewer = login("widz")
    viewer.post("/api/devices?probe=false", json={"name": "SW", "host": "10.7.0.9", "community": "tajne-community"})
    created = admin.post("/api/devices?probe=false", json={"name": "SW", "host": "10.7.0.9", "community": "tajne-community"})
    assert created.status_code == 201, created.text

    page = admin.get("/api/audit").json()
    actions = [(e["username"], e["action"], e["status"]) for e in page["items"]]
    assert ("admin", "POST /api/devices", 201) in actions
    assert ("widz", "POST /api/devices", 403) in actions
    assert ("admin", "POST /api/users", 201) in actions
    assert ("widz", "login", None) in actions and ("admin", "setup", None) in actions
    assert ("admin", "login_failed", None) in actions
    assert "tajne-community" not in str(page)  # bez treści żądań
    assert page["total"] == len(page["items"])

    denied = admin.get("/api/audit", params={"kind": "denied"}).json()["items"]
    assert {e["action"] for e in denied} == {"login_failed", "POST /api/devices"}
    assert all(e["action"] in {"login", "login_failed", "setup"} for e in admin.get("/api/audit", params={"kind": "auth"}).json()["items"])
    assert {e["username"] for e in admin.get("/api/audit", params={"q": "widz"}).json()["items"]} == {"widz"}
    assert admin.get("/api/audit", params={"limit": 2}).json()["items"].__len__() == 2

