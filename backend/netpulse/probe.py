"""Jednorazowe odpytanie urządzenia (bez zapisu) – test połączenia w CLI i API."""

from __future__ import annotations

from .config import settings
from .drivers import PollResult, poll_device
from .snmp import SnmpCredentials


async def probe(host: str, port: int, creds: SnmpCredentials, driver: str = "auto") -> PollResult:
    from .snmp.client import PySnmpClient

    client = PySnmpClient(host, creds, port=port, timeout=settings.snmp_timeout, retries=settings.snmp_retries)
    try:
        return await poll_device(client, driver)
    finally:
        await client.close()
