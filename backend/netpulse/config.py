"""Konfiguracja z zmiennych środowiskowych (prefiks NETPULSE_)."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(name: str, default: str) -> str:
    return os.environ.get(f"NETPULSE_{name}", default)


@dataclass(frozen=True)
class Settings:
    database_url: str = _env(
        "DATABASE_URL", "postgresql+asyncpg://netpulse:netpulse@localhost:5432/netpulse"
    )
    # Co ile sekund odpytywać urządzenia
    poll_interval: int = int(_env("POLL_INTERVAL", "30"))
    # Ile urządzeń odpytywać równolegle
    poll_concurrency: int = int(_env("POLL_CONCURRENCY", "16"))
    snmp_timeout: float = float(_env("SNMP_TIMEOUT", "2"))
    snmp_retries: int = int(_env("SNMP_RETRIES", "1"))
    # Ile dni trzymać surowe metryki (TimescaleDB retention policy)
    retention_days: int = int(_env("RETENTION_DAYS", "30"))
    api_host: str = _env("API_HOST", "0.0.0.0")
    api_port: int = int(_env("API_PORT", "8000"))
    log_level: str = _env("LOG_LEVEL", "INFO")


settings = Settings()
