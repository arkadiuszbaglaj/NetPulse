"""Połączenie z bazą i inicjalizacja schematu."""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from ..config import settings
from .models import HYPERTABLES, Base

log = logging.getLogger(__name__)

engine: AsyncEngine = create_async_engine(settings.database_url, pool_pre_ping=True)
Session = async_sessionmaker(engine, expire_on_commit=False)


async def has_timescale(conn) -> bool:
    res = await conn.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'"))
    return res.scalar() is not None


async def init_db(retention_days: int | None = None) -> bool:
    """Tworzy tabele i hypertables (idempotentnie). Zwraca True, jeśli TimescaleDB jest aktywne."""
    retention_days = retention_days or settings.retention_days
    async with engine.begin() as conn:
        try:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))
        except Exception as exc:  # zwykły PostgreSQL bez Timescale (np. testy)
            log.warning("TimescaleDB niedostępne: %s", exc)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        timescale = await has_timescale(conn)
        if timescale:
            for table in HYPERTABLES:
                await conn.execute(
                    text(
                        "SELECT create_hypertable(:t, by_range('time', INTERVAL '1 day'), "
                        "if_not_exists => TRUE, migrate_data => TRUE)"
                    ),
                    {"t": table},
                )
                await conn.execute(
                    text(
                        "SELECT add_retention_policy(:t, make_interval(days => :d), if_not_exists => TRUE)"
                    ),
                    {"t": table, "d": retention_days},
                )
    log.info("Schemat bazy gotowy (TimescaleDB: %s)", "tak" if timescale else "nie")
    return timescale


__all__ = ["Session", "engine", "has_timescale", "init_db"]
