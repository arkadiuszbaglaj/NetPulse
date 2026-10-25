"""Sekrety w bazie: zapis zaszyfrowany, odczyt przez ORM jawny, szyfrowanie wartości sprzed 0.15.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from sqlalchemy import delete, select, text  # noqa: E402

from netpulse import crypto  # noqa: E402
from netpulse.db import Session, encrypt_existing, engine, init_db  # noqa: E402
from netpulse.db.models import Controller, Device, NotificationChannel  # noqa: E402


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


@pytest.fixture(autouse=True)
def clean():
    async def reset():
        await init_db()
        async with Session() as s, s.begin():
            await s.execute(delete(Device))
            await s.execute(delete(Controller))
            await s.execute(delete(NotificationChannel))

    crypto.set_key("klucz-testowy-bazy")
    run(reset)
    yield
    run(reset)
    crypto.set_key(None)


async def raw(sql: str) -> list:
    async with engine.connect() as conn:
        return (await conn.execute(text(sql))).all()


def test_secrets_are_encrypted_at_rest_and_plain_through_orm():
    async def scenario():
        async with Session() as s, s.begin():
            s.add(Device(name="SW", host="10.8.0.1", community="tajne-community", v3_auth_key="klucz-auth-123"))
            s.add(Controller(name="UniFi", host="10.8.0.2", api_key="klucz-api-unifi"))
            s.add(NotificationChannel(name="Discord", url="https://discord.example/api/webhooks/1/sekret"))
        rows = await raw("SELECT community, v3_auth_key, v3_priv_key FROM devices")
        api = await raw("SELECT api_key FROM controllers")
        url = await raw("SELECT url FROM notification_channels")
        async with Session() as s:
            device = await s.scalar(select(Device))
            controller = await s.scalar(select(Controller))
            channel = await s.scalar(select(NotificationChannel))
        return rows, api, url, device, controller, channel

    rows, api, url, device, controller, channel = run(scenario)
    assert rows[0][0].startswith(crypto.PREFIX) and rows[0][1].startswith(crypto.PREFIX) and rows[0][2] is None
    assert api[0][0].startswith(crypto.PREFIX) and url[0][0].startswith(crypto.PREFIX)
    assert "tajne" not in rows[0][0] and "sekret" not in url[0][0]
    assert device.community == "tajne-community" and device.v3_auth_key == "klucz-auth-123"
    assert controller.api_key == "klucz-api-unifi"
    assert channel.url.endswith("/sekret")


def test_plaintext_from_older_version_is_encrypted_on_start():
    async def scenario():
        async with engine.begin() as conn:
            await conn.execute(text("INSERT INTO devices (name, host, port, enabled, driver, snmp_version, community, kind, status) "
                                    "VALUES ('Stary', '10.8.0.9', 161, true, 'auto', '2c', 'public', 'other', 'unknown')"))
        async with engine.begin() as conn:
            first = await encrypt_existing(conn)
        async with engine.begin() as conn:
            second = await encrypt_existing(conn)
        stored = await raw("SELECT community FROM devices")
        async with Session() as s:
            device = await s.scalar(select(Device))
        return first, second, stored[0][0], device.community

    first, second, stored, community = run(scenario)
    assert first == 1 and second == 0
    assert stored.startswith(crypto.PREFIX)
    assert community == "public"


def test_wrong_key_reads_secret_as_empty_but_keeps_device():
    async def write():
        async with Session() as s, s.begin():
            s.add(Device(name="SW", host="10.8.0.1", community="tajne"))

    run(write)
    crypto.set_key("zupelnie-inny-klucz")

    async def read():
        async with Session() as s:
            return await s.scalar(select(Device))

    device = run(read)
    assert device.name == "SW" and device.community is None
