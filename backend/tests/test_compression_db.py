"""Kompresja TimescaleDB na prawdziwej bazie (od 0.67.0): zasady po `init_db`, odczyt, zapis i usuwanie
w skompresowanych chunkach, pamięć sesji API.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy z TimescaleDB).
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete, func, select, text  # noqa: E402

from netpulse import compression  # noqa: E402
from netpulse.api import app, security  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.db import Session, engine, has_timescale, init_db  # noqa: E402
from netpulse.db.models import (  # noqa: E402
    HYPERTABLES,
    AuthSession,
    Device,
    DeviceMetric,
    Interface,
    InterfaceMetric,
    User,
)

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
        await s.execute(delete(Device))
        await s.execute(delete(User))


async def _timescale() -> bool:
    async with engine.connect() as conn:
        return await has_timescale(conn)


@pytest.fixture
def clean():
    login_limiter._failures.clear()
    security.forget_sessions()
    run(_reset)
    yield
    security.forget_sessions()
    run(_reset)


def test_init_db_enables_compression_on_every_hypertable(clean):
    async def go():
        if not await _timescale():
            pytest.skip("baza bez TimescaleDB")
        async with engine.connect() as conn:
            enabled = {
                r[0]
                for r in await conn.execute(
                    text("SELECT hypertable_name FROM timescaledb_information.hypertables WHERE compression_enabled")
                )
            }
            policies = {
                r[0]
                for r in await conn.execute(
                    text("SELECT hypertable_name FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'")
                )
            }
        assert set(HYPERTABLES) <= enabled
        assert set(HYPERTABLES) <= policies
        # Drugie uruchomienie niczego nie psuje ani nie dubluje
        await init_db()
        async with engine.connect() as conn:
            count = (
                await conn.execute(text("SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'"))
            ).scalar()
        assert count == len(HYPERTABLES)

    run(go)


def test_compressed_chunks_read_write_and_cascade_delete(clean):
    """Stare dane po kompresji dalej się czytają (wykres 30 dni z agregatu i surowe zapytanie), spóźniony zapis
    do skompresowanego chunku działa, a usunięcie urządzenia usuwa też jego skompresowane metryki."""

    async def go():
        if not await _timescale():
            pytest.skip("baza bez TimescaleDB")
        old = datetime.now(UTC) - timedelta(days=10)
        async with Session() as s, s.begin():
            dev = Device(name="USW", host="10.0.0.2", community="public", kind="switch", status="up")
            s.add(dev)
            await s.flush()
            port = Interface(device_id=dev.id, if_index=1, name="0/1", label="Port 1", oper_status="up", speed_mbps=1000)
            s.add(port)
            await s.flush()
            for i in range(20):
                t = old + timedelta(seconds=30 * i)
                s.add(DeviceMetric(time=t, device_id=dev.id, reachable=True, cpu_percent=10.0 + i))
                s.add(InterfaceMetric(time=t, interface_id=port.id, in_bps=1000.0 * i, out_bps=500.0, oper_up=True))
            dev_id, port_id = dev.id, port.id
        async with engine.connect() as base:
            conn = await base.execution_options(isolation_level="AUTOCOMMIT")
            for table in ("device_metrics", "interface_metrics"):
                await conn.execute(
                    text(f"SELECT compress_chunk(c, if_not_compressed => TRUE) FROM show_chunks('{table}', older_than => INTERVAL '7 days') c")
                )
            compressed = (
                await conn.execute(
                    text(
                        "SELECT count(*) FROM timescaledb_information.chunks "
                        "WHERE hypertable_name IN ('device_metrics', 'interface_metrics') AND is_compressed"
                    )
                )
            ).scalar()
        assert compressed >= 2
        async with Session() as s, s.begin():
            assert await s.scalar(select(func.count()).select_from(DeviceMetric).where(DeviceMetric.device_id == dev_id)) == 20
            assert await s.scalar(select(func.max(InterfaceMetric.in_bps)).where(InterfaceMetric.interface_id == port_id)) == 19000.0
            # Spóźniona próbka trafia do skompresowanego chunku
            s.add(DeviceMetric(time=old + timedelta(minutes=30), device_id=dev_id, reachable=False))
        async with Session() as s, s.begin():
            assert await s.scalar(select(func.count()).select_from(DeviceMetric).where(DeviceMetric.device_id == dev_id)) == 21
            await s.execute(delete(Device).where(Device.id == dev_id))
        async with Session() as s:
            assert await s.scalar(select(func.count()).select_from(DeviceMetric).where(DeviceMetric.device_id == dev_id)) == 0
            assert await s.scalar(select(func.count()).select_from(InterfaceMetric).where(InterfaceMetric.interface_id == port_id)) == 0

    run(go)


def test_compression_can_be_switched_off(clean):
    async def go():
        if not await _timescale():
            pytest.skip("baza bez TimescaleDB")
        async with engine.begin() as conn:
            assert await compression.ensure(conn, HYPERTABLES, 30, 0) == []
            left = (
                await conn.execute(text("SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'"))
            ).scalar()
        assert left == 0
        await init_db()  # przywraca zasady dla kolejnych testów

    run(go)


def test_session_cache_skips_database_until_forgotten(clean, monkeypatch):
    """Pamięć sesji: sprawdzona sesja nie pyta bazy; wylogowanie i zmiany kont czyszczą ją od razu."""
    monkeypatch.setattr(security, "SESSION_CACHE_S", 30.0)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        assert c.get("/api/auth/me").status_code == 200
        assert len(security._sessions) == 1

        # Sesja usunięta wprost w bazie (np. inny proces): pamięć jeszcze ją zna, po wyczyszczeniu – 401
        async def drop():
            async with Session() as s, s.begin():
                await s.execute(delete(AuthSession))

        run(drop)
        assert c.get("/api/auth/me").status_code == 200
        security.forget_sessions()
        assert c.get("/api/auth/me").status_code == 401

        # Wylogowanie przez API działa natychmiast, bez czekania na wygaśnięcie wpisu
        assert c.post("/api/auth/login", json=ADMIN).status_code == 200
        assert c.get("/api/auth/me").status_code == 200
        assert c.post("/api/auth/logout").status_code == 204
        assert security._sessions == {}
        assert c.get("/api/auth/me").status_code == 401


def test_session_cache_sees_role_change_at_once(clean, monkeypatch):
    monkeypatch.setattr(security, "SESSION_CACHE_S", 30.0)
    with TestClient(app) as admin:
        assert admin.post("/api/auth/setup", json=ADMIN).status_code == 201
        res = admin.post("/api/users", json={"username": "jan", "password": "haslo-konta-123", "role": "operator"})
        assert res.status_code == 201, res.text
        with TestClient(app) as jan:
            assert jan.post("/api/auth/login", json={"username": "jan", "password": "haslo-konta-123"}).status_code == 200
            assert jan.get("/api/auth/me").json()["role"] == "operator"
            # Zmiana roli wylogowuje konto – także z pamięci sesji
            assert admin.patch(f"/api/users/{res.json()['id']}", json={"role": "viewer"}).status_code == 200
            assert jan.get("/api/auth/me").status_code == 401


def test_timescale_extension_update_is_safe_to_repeat(clean):
    """`ALTER EXTENSION … UPDATE` przy każdym starcie (od 0.68.0): przy aktualnej wersji nic nie zmienia, a baza
    po nim działa; zwraca wersję w bazie i w obrazie."""
    from netpulse.db import update_timescale_extension

    async def go():
        if not await _timescale():
            pytest.skip("baza bez TimescaleDB")
        versions = await update_timescale_extension()
        assert versions is not None and versions[0] == versions[1], versions
        await init_db()
        async with Session() as s:
            assert await s.scalar(select(func.count()).select_from(Device)) == 0

    run(go)


def test_account_login_limit_over_api(clean):
    """Konto blokuje się po 20 nieudanych próbach niezależnie od limitu adresu; adres znany z udanego logowania wchodzi."""
    from netpulse.api.security import USER_MAX_FAILURES, username_key

    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        assert c.post("/api/auth/logout").status_code == 204
        login_limiter._trusted.clear()  # jak po restarcie API: żaden adres nie jest znany
        for _ in range(USER_MAX_FAILURES):
            login_limiter.failure(username_key("admin"))  # próby z innych adresów
        assert c.post("/api/auth/login", json=ADMIN).status_code == 429
        # Inne konto z tego samego adresu nie jest zablokowane (tu: nie istnieje, więc 401, nie 429)
        assert c.post("/api/auth/login", json={"username": "jan", "password": "x" * 12}).status_code == 401
        login_limiter._failures.clear()
        assert c.post("/api/auth/login", json=ADMIN).status_code == 200
        # Adres po udanym logowaniu jest znany – blokada konta go nie dotyczy
        for _ in range(USER_MAX_FAILURES):
            login_limiter.failure(username_key("admin"))
        assert c.post("/api/auth/login", json=ADMIN).status_code == 200
    login_limiter._failures.clear()
    login_limiter._trusted.clear()

