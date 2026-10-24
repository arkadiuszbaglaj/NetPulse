"""API z prawdziwą bazą: kreator, logowanie, sesje, CSRF, urządzenia (CRUD).

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
from netpulse.api.security import COOKIE, login_limiter  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Device, User  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}


def _reset_db() -> None:
    async def run():
        await init_db()
        async with Session() as s, s.begin():
            await s.execute(delete(User))
            await s.execute(delete(Device))
        await engine.dispose()

    asyncio.run(run())


@pytest.fixture
def client():
    _reset_db()
    login_limiter._failures.clear()
    with TestClient(app) as c:
        yield c
    login_limiter._failures.clear()
    _reset_db()


def test_setup_login_logout(client):
    st = client.get("/api/auth/status").json()
    assert st["setup_required"] is True and st["authenticated"] is False

    # Bez konta i bez logowania dane są zamknięte
    assert client.get("/api/devices").status_code == 401
    assert client.get("/api/health").status_code == 200

    r = client.post("/api/auth/setup", json={"username": "admin", "password": "krotkie"})
    assert r.status_code == 422
    r = client.post("/api/auth/setup", json=ADMIN)
    assert r.status_code == 201, r.text
    assert r.json()["username"] == "admin"
    cookie = r.headers["set-cookie"]
    assert COOKIE in cookie and "HttpOnly" in cookie and "samesite=lax" in cookie.lower()

    st = client.get("/api/auth/status").json()
    assert st["setup_required"] is False and st["authenticated"] is True
    assert client.get("/api/auth/me").json()["username"] == "admin"
    assert client.get("/api/devices").status_code == 200

    # Kreator działa tylko raz
    assert client.post("/api/auth/setup", json={"username": "drugi", "password": "inne-haslo-1"}).status_code == 409

    assert client.post("/api/auth/logout").status_code == 204
    client.cookies.clear()
    assert client.get("/api/devices").status_code == 401

    assert client.post("/api/auth/login", json={**ADMIN, "password": "zle-haslo"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "nikt", "password": "x"}).status_code == 401
    assert client.post("/api/auth/login", json=ADMIN).status_code == 200
    assert client.get("/api/devices").status_code == 200


def test_logout_invalidates_token(client):
    client.post("/api/auth/setup", json=ADMIN)
    token = client.cookies.get(COOKIE)
    assert token
    client.post("/api/auth/logout")
    client.cookies.clear()
    # stary token po wylogowaniu nic nie daje
    assert client.get("/api/devices", headers={"Cookie": f"{COOKIE}={token}"}).status_code == 401


def test_password_change(client):
    client.post("/api/auth/setup", json=ADMIN)
    other = TestClient(app)
    assert other.post("/api/auth/login", json=ADMIN).status_code == 200

    r = client.post("/api/auth/password", json={"current_password": "zle", "new_password": "nowe-haslo-1"})
    assert r.status_code == 403
    r = client.post("/api/auth/password", json={"current_password": ADMIN["password"], "new_password": "krotkie"})
    assert r.status_code == 422
    r = client.post(
        "/api/auth/password", json={"current_password": ADMIN["password"], "new_password": "nowe-haslo-1"}
    )
    assert r.status_code == 204
    # Bieżąca sesja zostaje, inne są wylogowane
    assert client.get("/api/devices").status_code == 200
    assert other.get("/api/devices").status_code == 401
    assert other.post("/api/auth/login", json=ADMIN).status_code == 401
    assert other.post("/api/auth/login", json={**ADMIN, "password": "nowe-haslo-1"}).status_code == 200


def test_login_rate_limit(client):
    client.post("/api/auth/setup", json=ADMIN)
    client.cookies.clear()
    for _ in range(login_limiter.max_failures):
        assert client.post("/api/auth/login", json={**ADMIN, "password": "zle"}).status_code == 401
    r = client.post("/api/auth/login", json=ADMIN)
    assert r.status_code == 429 and "Retry-After" in r.headers


def test_csrf_other_origin_rejected(client):
    client.post("/api/auth/setup", json=ADMIN)
    body = {"name": "x", "host": "10.9.9.9"}
    r = client.post("/api/devices?probe=false", json=body, headers={"Origin": "http://evil.example:3000"})
    assert r.status_code == 403
    r = client.post("/api/devices?probe=false", json=body, headers={"Origin": "http://testserver"})
    assert r.status_code == 201


def test_device_crud(client):
    client.post("/api/auth/setup", json=ADMIN)

    r = client.post(
        "/api/devices?probe=false",
        json={"name": "Switch", "host": "10.9.9.2", "community": "tajne-community"},
    )
    assert r.status_code == 201, r.text
    dev = r.json()
    assert dev["name"] == "Switch" and dev["port"] == 161 and dev["snmp_version"] == "2c"
    assert "community" not in dev and "tajne-community" not in r.text

    assert client.post("/api/devices?probe=false", json={"name": "dup", "host": "10.9.9.2"}).status_code == 409
    r = client.post("/api/devices?probe=false", json={"name": "v3", "host": "10.9.9.3", "snmp_version": "3"})
    assert r.status_code == 422

    v3 = {
        "name": "Router v3",
        "host": "10.9.9.4",
        "snmp_version": "3",
        "v3_username": "monitor",
        "v3_auth_protocol": "SHA",
        "v3_auth_key": "auth-klucz-1",
        "v3_priv_protocol": "AES",
        "v3_priv_key": "priv-klucz-1",
    }
    r = client.post("/api/devices?probe=false", json=v3)
    assert r.status_code == 201, r.text
    assert r.json()["v3_auth_protocol"] == "SHA" and "auth-klucz-1" not in r.text

    dev_id = dev["id"]
    r = client.patch(f"/api/devices/{dev_id}", json={"name": "USW Lite 8", "enabled": False})
    assert r.status_code == 200 and r.json()["name"] == "USW Lite 8" and r.json()["enabled"] is False

    # Niespójna zmiana jest odrzucana i nic nie zapisuje
    r = client.patch(f"/api/devices/{dev_id}", json={"snmp_version": "3", "name": "zmienione"})
    assert r.status_code == 422
    assert client.get(f"/api/devices/{dev_id}").json()["name"] == "USW Lite 8"
    assert client.patch(f"/api/devices/{dev_id}", json={"host": "10.9.9.4"}).status_code == 409
    assert client.patch(f"/api/devices/{dev_id}", json={"name": None}).status_code == 422

    # Community zostało zachowane (sekret pominięty w PATCH)
    async def community():
        async with Session() as s:
            c = (await s.get(Device, dev_id)).community
        await engine.dispose()
        return c

    assert asyncio.run(community()) == "tajne-community"

    assert client.get(f"/api/devices/{dev_id}/interfaces").json() == []
    assert client.get("/api/devices/99999/interfaces").status_code == 404
    assert client.get("/api/devices/99999/metrics").status_code == 404
    assert len(client.get("/api/devices").json()) == 2

    assert client.delete(f"/api/devices/{dev_id}").status_code == 204
    assert client.get(f"/api/devices/{dev_id}").status_code == 404
    assert client.delete(f"/api/devices/{dev_id}").status_code == 404


def test_probe_unreachable_device(client):
    client.post("/api/auth/setup", json=ADMIN)
    # TEST-NET-1 (RFC 5737) – nikt nie odpowie
    r = client.post("/api/probe", json={"host": "192.0.2.1"})
    assert r.status_code == 422 and "SNMP" in r.json()["detail"]
    r = client.post("/api/devices", json={"name": "x", "host": "192.0.2.1"})
    assert r.status_code == 422
    assert client.get("/api/devices").json() == []
