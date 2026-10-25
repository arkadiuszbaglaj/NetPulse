"""Ustawienia automatycznego sprawdzania aktualizacji (na całą instalację) w prawdziwej bazie."""

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
from netpulse.auth import hash_password  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import AppSetting, Device, User  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
OTHER = {"username": "domownik", "password": "inne-haslo-123"}


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


def reset_db() -> None:
    async def go():
        await init_db()
        async with Session() as s, s.begin():
            await s.execute(delete(User))
            await s.execute(delete(Device))
            await s.execute(delete(AppSetting))

    run(go)


@pytest.fixture
def client():
    reset_db()
    login_limiter._failures.clear()
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    reset_db()


def test_defaults_to_enabled_daily(client):
    assert client.get("/api/updates/settings").json() == {"auto_check": True, "interval_h": 24}


def test_admin_can_disable_and_change_interval(client):
    r = client.put("/api/updates/settings", json={"auto_check": False, "interval_h": 6})
    assert r.status_code == 200 and r.json() == {"auto_check": False, "interval_h": 6}
    assert client.get("/api/updates/settings").json() == {"auto_check": False, "interval_h": 6}
    # kolejny zapis nadpisuje ten sam wiersz
    client.put("/api/updates/settings", json={"auto_check": True, "interval_h": 168})
    assert client.get("/api/updates/settings").json() == {"auto_check": True, "interval_h": 168}


def test_rejects_unknown_interval(client):
    assert client.put("/api/updates/settings", json={"auto_check": True, "interval_h": 5}).status_code == 422


def test_non_admin_can_read_but_not_change(client):
    async def add_user():
        async with Session() as s, s.begin():
            s.add(User(username=OTHER["username"], password_hash=hash_password(OTHER["password"]), is_admin=False))

    run(add_user)
    other = TestClient(app)
    assert other.post("/api/auth/login", json=OTHER).status_code == 200
    assert other.get("/api/updates/settings").status_code == 200
    assert other.put("/api/updates/settings", json={"auto_check": False, "interval_h": 24}).status_code == 403


def test_requires_login():
    with TestClient(app) as c:
        assert c.get("/api/updates/settings").status_code == 401
