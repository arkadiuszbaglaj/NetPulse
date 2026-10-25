"""Układ pulpitu i preferencje konta na prawdziwej bazie.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete, func, insert, select  # noqa: E402

from netpulse.api import app  # noqa: E402
from netpulse.api.layout_schemas import DashboardLayout  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.auth import hash_password  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import Dashboard, Device, User, UserPreference  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
OTHER = {"username": "domownik", "password": "inne-haslo-123"}

_RAW_LAYOUT = {
    "version": 1,
    "widgets": [
        {"id": "s1", "type": "summary", "w": 12, "config": {"tiles": ["devices", "wan_down"]}},
        {
            "id": "c1",
            "type": "chart",
            "w": 8,
            "config": {
                "title": "Ruch na porcie 7",
                "source": {"kind": "interface", "id": 7},
                "series": [{"key": "in_bps", "color": 1}, {"key": "out_bps", "color": 3}],
                "chart": "line",
                "unit": "bytes",
                "smooth": True,
                "range_min": 360,
                "refresh_s": 10,
                "height": "lg",
            },
        },
        {"id": "d1", "type": "devices", "w": 12, "config": {"kinds": ["switch", "ap"]}},
    ],
}

# API zwraca układ z uzupełnionymi wartościami domyślnymi, więc porównujemy postać znormalizowaną
LAYOUT = DashboardLayout.model_validate(_RAW_LAYOUT).model_dump(mode="json")


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

    run(go)


@pytest.fixture
def client():
    reset_db()
    login_limiter._failures.clear()
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    reset_db()


def second_user_client() -> TestClient:
    async def go():
        async with Session() as s, s.begin():
            s.add(User(username=OTHER["username"], password_hash=hash_password(OTHER["password"]), is_admin=False))

    run(go)
    c = TestClient(app)
    assert c.post("/api/auth/login", json=OTHER).status_code == 200
    return c


def test_requires_login():
    with TestClient(app) as c:
        assert c.get("/api/dashboards/default").status_code == 401
        assert c.put("/api/dashboards/default", json=LAYOUT).status_code == 401
        assert c.delete("/api/dashboards/default").status_code == 401
        assert c.get("/api/preferences").status_code == 401
        assert c.put("/api/preferences/refresh", json={"interval_s": 30, "range_min": 60}).status_code == 401


def test_no_saved_layout_means_default(client):
    assert client.get("/api/dashboards/default").json() == {"layout": None, "updated_at": None}


def test_save_and_load_layout(client):
    r = client.put("/api/dashboards/default", json=LAYOUT)
    assert r.status_code == 200, r.text
    assert r.json()["layout"] == LAYOUT and r.json()["updated_at"]
    got = client.get("/api/dashboards/default").json()
    assert got["layout"] == LAYOUT


def test_update_replaces_and_keeps_single_row(client):
    client.put("/api/dashboards/default", json=LAYOUT)
    smaller = {"version": 1, "widgets": [LAYOUT["widgets"][0]]}
    assert client.put("/api/dashboards/default", json=smaller).status_code == 200
    assert client.get("/api/dashboards/default").json()["layout"] == smaller

    async def count():
        async with Session() as s:
            return await s.scalar(select(func.count()).select_from(Dashboard))

    assert run(count) == 1


def test_invalid_layout_is_rejected_and_nothing_is_saved(client):
    bad = {"version": 1, "widgets": [{**LAYOUT["widgets"][1], "w": 13}]}
    assert client.put("/api/dashboards/default", json=bad).status_code == 422
    wrong_metric = {
        "version": 1,
        "widgets": [{"id": "c", "type": "chart", "w": 6, "config": {"source": {"kind": "wan"}, "series": [{"key": "cpu_percent"}]}}],
    }
    r = client.put("/api/dashboards/default", json=wrong_metric)
    assert r.status_code == 422
    assert client.get("/api/dashboards/default").json()["layout"] is None


def test_reset_returns_to_default(client):
    client.put("/api/dashboards/default", json=LAYOUT)
    assert client.delete("/api/dashboards/default").status_code == 204
    assert client.get("/api/dashboards/default").json()["layout"] is None
    assert client.delete("/api/dashboards/default").status_code == 204  # powtórne usunięcie nie szkodzi


def test_layouts_are_per_user(client):
    client.put("/api/dashboards/default", json=LAYOUT)
    other = second_user_client()
    assert other.get("/api/dashboards/default").json()["layout"] is None
    mine = {"version": 1, "widgets": [LAYOUT["widgets"][2]]}
    assert other.put("/api/dashboards/default", json=mine).status_code == 200
    assert client.get("/api/dashboards/default").json()["layout"] == LAYOUT  # pulpit pierwszego użytkownika bez zmian
    assert other.get("/api/dashboards/default").json()["layout"] == mine
    other.delete("/api/dashboards/default")
    assert client.get("/api/dashboards/default").json()["layout"] == LAYOUT


def test_stale_stored_layout_falls_back_to_default(client):
    """Układ zapisany w nieaktualnym schemacie (np. po zmianie wersji) nie psuje panelu – jest traktowany jak brak."""

    async def put_junk():
        async with Session() as s, s.begin():
            uid = await s.scalar(select(User.id).where(User.username == "admin"))
            await s.execute(insert(Dashboard).values(owner_id=uid, layout={"version": 99, "widgets": "śmieci"}))

    run(put_junk)
    r = client.get("/api/dashboards/default")
    assert r.status_code == 200 and r.json()["layout"] is None


def test_concurrent_first_saves_create_one_dashboard(client):
    def save(_):
        return client.put("/api/dashboards/default", json=LAYOUT).status_code

    with ThreadPoolExecutor(6) as pool:
        assert set(pool.map(save, range(6))) == {200}

    async def count():
        async with Session() as s:
            return await s.scalar(select(func.count()).select_from(Dashboard))

    assert run(count) == 1


def test_deleting_user_removes_their_layout(client):
    client.put("/api/dashboards/default", json=LAYOUT)

    async def delete_user_and_count():
        async with Session() as s, s.begin():
            await s.execute(delete(User))
        async with Session() as s:
            return await s.scalar(select(func.count()).select_from(Dashboard))

    assert run(delete_user_and_count) == 0


def test_refresh_preferences_roundtrip(client):
    assert client.get("/api/preferences").json() == {"refresh": None}
    r = client.put("/api/preferences/refresh", json={"interval_s": 10, "range_min": 360})
    assert r.status_code == 200 and r.json() == {"interval_s": 10, "range_min": 360}
    assert client.get("/api/preferences").json() == {"refresh": {"interval_s": 10, "range_min": 360}}
    client.put("/api/preferences/refresh", json={"interval_s": 0, "range_min": 15})
    assert client.get("/api/preferences").json()["refresh"] == {"interval_s": 0, "range_min": 15}


def test_refresh_preferences_validation_and_isolation(client):
    for bad in ({"interval_s": 7, "range_min": 60}, {"interval_s": 30, "range_min": 5}, {"interval_s": 30}):
        assert client.put("/api/preferences/refresh", json=bad).status_code == 422
    client.put("/api/preferences/refresh", json={"interval_s": 5, "range_min": 15})
    other = second_user_client()
    assert other.get("/api/preferences").json() == {"refresh": None}


def test_preferences_row_is_single_and_survives_concurrent_first_writes(client):
    def save(i):
        return client.put("/api/preferences/refresh", json={"interval_s": 5 if i % 2 else 10, "range_min": 60}).status_code

    with ThreadPoolExecutor(6) as pool:
        assert set(pool.map(save, range(6))) == {200}

    async def count():
        async with Session() as s:
            return await s.scalar(select(func.count()).select_from(UserPreference))

    assert run(count) == 1
