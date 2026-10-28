"""Wiele pulpitów i pulpity publiczne na prawdziwej bazie: link /p/<token>, biała lista danych, PIN, wygasanie.

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
from sqlalchemy import delete, text, update  # noqa: E402

from netpulse import crypto  # noqa: E402
from netpulse.api import app  # noqa: E402
from netpulse.api.public import pin_limiter  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Dashboard, Device, User  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}

LAYOUT = {
    "version": 1,
    "widgets": [
        {"id": "sum", "type": "summary", "w": 12, "config": {"tiles": ["devices", "wan_down"]}},
        {"id": "wan", "type": "chart", "w": 8, "config": {"source": {"kind": "wan"}, "series": [{"key": "in_bps"}]}},
        {"id": "dev", "type": "devices", "w": 12, "config": {}},
    ],
}


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


async def _clean():
    async with Session() as s, s.begin():
        await s.execute(delete(Device))
        await s.execute(delete(User))


@pytest.fixture
def client():
    login_limiter._failures.clear()
    pin_limiter._failures.clear()

    async def go():
        await init_db()
        await _clean()
        async with Session() as s, s.begin():
            s.add(Device(name="UCG", host="192.168.1.1", community="tajne", kind="gateway", status="up", last_error="timeout 192.168.1.1"))

    run(go)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(_clean)


def anon() -> TestClient:
    return TestClient(app)  # bez ciasteczka sesji – jak obcy na wyświetlaczu ściennym


def share(client, dashboard_id: int, **body) -> dict:
    res = client.put(f"/api/dashboards/{dashboard_id}/public", json={"enabled": True, **body})
    assert res.status_code == 200, res.text
    return res.json()


def test_many_dashboards_and_default(client):
    created = client.post("/api/dashboards", json={"name": "  Ściana  ", "layout": LAYOUT})
    assert created.status_code == 201, created.text
    wall = created.json()
    assert (wall["name"], wall["is_default"], wall["widgets"], wall["public"]) == ("Ściana", False, 3, None)
    assert client.post("/api/dashboards", json={"name": " ", "layout": LAYOUT}).status_code == 422

    renamed = client.patch(f"/api/dashboards/{wall['id']}", json={"name": "Salon"}).json()
    assert renamed["name"] == "Salon" and renamed["layout"]["widgets"][0]["id"] == "sum"
    assert client.get("/api/dashboards/default").json()["layout"] is None  # domyślny wciąż z panelu

    assert client.post(f"/api/dashboards/{wall['id']}/default").json()["is_default"] is True
    assert client.get("/api/dashboards/default").json()["layout"]["widgets"][1]["id"] == "wan"
    listed = client.get("/api/dashboards").json()
    assert [(d["name"], d["is_default"]) for d in listed] == [("Salon", True)]

    assert client.delete(f"/api/dashboards/{wall['id']}").status_code == 204
    assert client.get(f"/api/dashboards/{wall['id']}").status_code == 404
    with anon() as stranger:
        assert stranger.get("/api/dashboards").status_code == 401


def test_public_link_serves_only_whitelisted_data(client):
    wall = client.post("/api/dashboards", json={"name": "Ściana", "layout": LAYOUT}).json()
    info = share(client, wall["id"], options={"refresh_s": 10, "range_min": 1440})
    token = info["public"]["token"]
    assert info["public"]["has_pin"] is False and info["public"]["options"]["range_min"] == 1440

    with anon() as tv:
        page = tv.get(f"/api/public/dashboards/{token}")
        assert page.status_code == 200 and page.headers["cache-control"] == "no-store"
        body = page.json()
        assert body["name"] == "Ściana" and body["locked"] is False and len(body["layout"]["widgets"]) == 3

        data = lambda path: tv.get(f"/api/public/dashboards/{token}/data", params={"path": path})  # noqa: E731
        assert data("/api/dashboard/summary").json()["devices"]["total"] == 1
        (device,) = data("/api/devices").json()
        # Adres, błąd z adresem i dane SNMP zostają w panelu
        assert device["name"] == "UCG" and device["host"] == "" and device["last_error"] is None and "community" not in device
        assert device["default_community"] is None  # słabe community to informacja tylko dla panelu
        assert data("/api/dashboard/traffic?minutes=60").status_code == 200
        assert data("/api/dashboard/traffic?minutes=7").status_code == 403  # zakres spoza listy
        # Przesunięcie w czasie tylko takie, jakie ma zapytanie wykresu na pulpicie (tu: żadne)
        assert data("/api/dashboard/traffic?minutes=60&offset=1440").status_code == 403
        assert data("/api/dashboard/traffic?minutes=60&offset=0").status_code == 200
        assert data("/api/availability?days=30").status_code == 200
        # Danych, których nie pokazuje żaden widget tego pulpitu, nie ma
        for path in ("/api/wan/status", "/api/devices/1/metrics", "/api/system", "/api/clients", "/api/alerts", "/api/dashboard/wifi"):
            assert data(path).status_code == 403, path
        # Reszta API bez logowania nadal zamknięta
        assert tv.get("/api/devices").status_code == 401
        assert tv.get("/api/public/dashboards/nie-ma-takiego-tokenu-123456").status_code == 404

    # Pokazanie adresów to świadomy wybór
    share(client, wall["id"], options={"hide_hosts": False})
    with anon() as tv:
        (device,) = tv.get(f"/api/public/dashboards/{token}/data", params={"path": "/api/devices"}).json()
        assert device["host"] == "192.168.1.1"


def test_pin_rotate_disable_and_expiry(client):
    wall = client.post("/api/dashboards", json={"name": "Ściana", "layout": LAYOUT}).json()
    # PIN tylko z cyfr
    assert client.put(f"/api/dashboards/{wall['id']}/public", json={"enabled": True, "pin": "12a4"}).status_code == 422
    token = share(client, wall["id"], pin="2468")["public"]["token"]

    with anon() as tv:
        locked = tv.get(f"/api/public/dashboards/{token}").json()
        assert locked["locked"] is True and locked["layout"] is None
        assert tv.get(f"/api/public/dashboards/{token}/data", params={"path": "/api/dashboard/summary"}).status_code == 401
        assert tv.post(f"/api/public/dashboards/{token}/unlock", json={"pin": "0000"}).status_code == 403
        access = tv.post(f"/api/public/dashboards/{token}/unlock", json={"pin": "2468"}).json()["access"]
        headers = {"X-Dashboard-Access": access}
        assert tv.get(f"/api/public/dashboards/{token}", headers=headers).json()["locked"] is False
        assert tv.get(f"/api/public/dashboards/{token}/data", params={"path": "/api/dashboard/summary"}, headers=headers).status_code == 200

    # Zmiana PIN-u unieważnia klucz dostępu
    share(client, wall["id"], pin="1357")
    with anon() as tv:
        assert tv.get(f"/api/public/dashboards/{token}", headers=headers).json()["locked"] is True

    # Nowy link: stary przestaje działać od razu
    rotated = client.post(f"/api/dashboards/{wall['id']}/public/rotate").json()["public"]["token"]
    assert rotated != token
    with anon() as tv:
        assert tv.get(f"/api/public/dashboards/{token}").status_code == 404
        assert tv.get(f"/api/public/dashboards/{rotated}").status_code == 200

    # Wygaśnięcie
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    assert client.put(f"/api/dashboards/{wall['id']}/public", json={"enabled": True, "expires_at": past}).status_code == 422
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    assert share(client, wall["id"], expires_at=future)["public"]["expired"] is False

    async def expire():
        async with Session() as s, s.begin():
            await s.execute(update(Dashboard).where(Dashboard.id == wall["id"]).values(public_expires_at=datetime.now(UTC) - timedelta(minutes=1)))

    run(expire)
    with anon() as tv:
        assert tv.get(f"/api/public/dashboards/{rotated}").status_code == 404
    assert client.get("/api/dashboards").json()[0]["public"]["expired"] is True

    # Wyłączenie: link znika, ponowne włączenie daje nowy
    off = client.put(f"/api/dashboards/{wall['id']}/public", json={"enabled": False}).json()
    assert off["public"] is None
    again = share(client, wall["id"])["public"]["token"]
    assert again not in (token, rotated)


def test_qr_code_and_secret_storage(client):
    wall = client.post("/api/dashboards", json={"name": "Ściana", "layout": LAYOUT}).json()
    assert client.get(f"/api/dashboards/{wall['id']}/public/qr.svg", params={"origin": "http://192.168.1.10:8080"}).status_code == 409
    token = share(client, wall["id"])["public"]["token"]
    qr = client.get(f"/api/dashboards/{wall['id']}/public/qr.svg", params={"origin": "http://192.168.1.10:8080"})
    assert qr.status_code == 200 and qr.headers["content-type"].startswith("image/svg+xml") and b"<svg" in qr.content
    assert client.get(f"/api/dashboards/{wall['id']}/public/qr.svg", params={"origin": "javascript:alert(1)"}).status_code == 422

    async def stored():
        async with Session() as s:
            return (await s.execute(text("SELECT public_token, public_token_hash FROM dashboards WHERE id = :id"), {"id": wall["id"]})).one()

    # W bazie: skrót do wyszukania, a sam token zaszyfrowany (o ile jest klucz szyfrowania)
    raw, digest = run(stored)
    assert digest != token and len(digest) == 64
    assert raw.startswith(crypto.PREFIX) or not crypto.enabled()


def test_reset_keeps_public_dashboard(client):
    wall = client.post("/api/dashboards", json={"name": "Ściana", "layout": LAYOUT, "make_default": True}).json()
    token = share(client, wall["id"])["public"]["token"]
    assert client.delete("/api/dashboards/default").status_code == 204
    assert client.get("/api/dashboards/default").json()["layout"] is None
    (kept,) = client.get("/api/dashboards").json()
    assert kept["is_default"] is False and kept["public"]["token"] == token
