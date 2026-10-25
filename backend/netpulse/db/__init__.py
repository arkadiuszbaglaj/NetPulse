"""Połączenie z bazą i inicjalizacja schematu (migracje Alembic: `migrate.py`, `migrations/`)."""

from __future__ import annotations

import logging

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from ..config import settings
from . import migrate
from .models import HYPERTABLES, Base

log = logging.getLogger(__name__)

engine: AsyncEngine = (
    create_async_engine(settings.database_url, poolclass=NullPool)
    if settings.db_nullpool
    else create_async_engine(settings.database_url, pool_pre_ping=True)
)
Session = async_sessionmaker(engine, expire_on_commit=False)


class SchemaMismatchError(RuntimeError):
    """Tabele w bazie mają inny układ niż oczekuje ta wersja (np. baza ze starszej instalacji)."""


def missing_columns(sync_conn) -> dict[str, list[str]]:
    """Kolumny z modeli, których brakuje w istniejących tabelach: {tabela: [kolumny]}."""
    insp = inspect(sync_conn)
    result: dict[str, list[str]] = {}
    for table in Base.metadata.sorted_tables:
        have = {c["name"] for c in insp.get_columns(table.name)}
        missing = [c.name for c in table.columns if c.name not in have]
        if missing:
            result[table.name] = missing
    return result


async def has_timescale(conn) -> bool:
    res = await conn.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'"))
    return res.scalar() is not None


async def init_db(retention_days: int | None = None) -> bool:
    """Migruje schemat do najnowszej wersji i zakłada hypertables (idempotentnie).

    Zwraca True, jeśli TimescaleDB jest aktywne."""
    retention_days = retention_days or settings.retention_days
    async with engine.begin() as conn:
        try:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb"))
        except Exception as exc:  # zwykły PostgreSQL bez Timescale (np. testy)
            log.warning("TimescaleDB niedostępne: %s", exc)
    async with engine.begin() as conn:
        # Kolektor i polecenia CLI mogą startować jednocześnie – migracje wykonuje jeden naraz
        await conn.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": migrate.LOCK_KEY})
        before = await conn.run_sync(migrate.current_revision)
        await conn.run_sync(migrate.upgrade)
        after = await conn.run_sync(migrate.current_revision)
        if before != after:
            log.info("Migracja schematu bazy: %s → %s", before or "brak", after)
        # Bezpiecznik: baza ze starej wersji, której migracja bazowa nie uzupełni (tabela bez kolumny)
        missing = await conn.run_sync(missing_columns)
        if missing:
            details = "; ".join(f"{t}: {', '.join(cols)}" for t, cols in missing.items())
            raise SchemaMismatchError(
                "Baza danych pochodzi ze starszej, niezgodnej wersji NetPulse "
                f"(brakujące kolumny – {details}).\n"
                "Jeśli nie potrzebujesz zapisanej historii, wyczyść bazę poleceniem: netpulse reset"
            )
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


__all__ = ["SchemaMismatchError", "Session", "engine", "has_timescale", "init_db", "missing_columns"]
