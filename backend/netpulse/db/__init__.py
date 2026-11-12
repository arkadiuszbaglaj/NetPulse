"""Połączenie z bazą i inicjalizacja schematu (migracje Alembic: `migrate.py`, `migrations/`)."""

from __future__ import annotations

import logging

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from .. import aggregates, compression, crypto
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


_timescale_seen = False


async def timescale_available() -> bool:
    """`has_timescale` bez pytania bazy przy każdym żądaniu API (od 0.65.4). Zapamiętuje tylko „jest” – API może
    wystartować przed `init_db` kolektora, który zakłada rozszerzenie, a raz założonego nikt nie usuwa."""
    global _timescale_seen
    if not _timescale_seen:
        async with engine.connect() as conn:
            _timescale_seen = await has_timescale(conn)
    return _timescale_seen


async def update_timescale_extension() -> tuple[str, str] | None:
    """Aktualizuje rozszerzenie TimescaleDB w bazie do wersji z obrazu (od 0.68.0, obraz ma przypiętą wersję).

    Po zmianie obrazu na nowszy baza ma jeszcze starą wersję rozszerzenia; `ALTER EXTENSION … UPDATE` musi być
    pierwszym poleceniem w świeżym połączeniu (zanim sesja załaduje starą bibliotekę) – dlatego osobne, surowe
    połączenie asyncpg, bez zapytań, które SQLAlchemy wykonuje przy łączeniu. Zwraca (stara, nowa) wersję,
    gdy coś się zmieniło. Brak rozszerzenia i błąd nie zatrzymują startu – dalej działa wersja dotychczasowa."""
    import asyncpg
    from sqlalchemy.engine import make_url

    dsn = make_url(settings.database_url).set(drivername="postgresql").render_as_string(hide_password=False)
    try:
        conn = await asyncpg.connect(dsn, timeout=10)
    except (OSError, asyncpg.PostgresError) as exc:
        log.warning("Aktualizacja rozszerzenia TimescaleDB pominięta (brak połączenia): %s", exc)
        return None
    try:
        await conn.execute("ALTER EXTENSION timescaledb UPDATE")
        row = await conn.fetchrow(
            "SELECT e.extversion AS now, a.default_version AS image FROM pg_extension e "
            "JOIN pg_available_extensions a ON a.name = e.extname WHERE e.extname = 'timescaledb'"
        )
    except asyncpg.UndefinedObjectError:
        return None  # świeża baza – rozszerzenie założy init_db
    except asyncpg.PostgresError as exc:
        log.error("Nie udało się zaktualizować rozszerzenia TimescaleDB: %s", exc)
        return None
    finally:
        await conn.close()
    return (row["now"], row["image"]) if row else None


async def encrypt_existing(conn) -> int:
    """Szyfruje sekrety zapisane jawnym tekstem (sprzed 0.15 albo sprzed ustawienia klucza). Zwraca liczbę wartości."""
    if not crypto.enabled():
        log.warning("Brak klucza szyfrowania (wolumen netpulse_keys albo NETPULSE_SECRET_KEY) – sekrety w bazie są jawnym tekstem")
        return 0
    done = 0
    for table, columns in crypto.SECRET_COLUMNS.items():
        id_col = "id"
        for column in columns:
            rows = (
                await conn.execute(
                    text(f"SELECT {id_col}, {column} FROM {table} WHERE {column} IS NOT NULL AND {column} <> '' "
                         f"AND {column} NOT LIKE :prefix"),
                    {"prefix": crypto.PREFIX + "%"},
                )
            ).all()
            for row_id, value in rows:
                await conn.execute(
                    text(f"UPDATE {table} SET {column} = :v WHERE {id_col} = :id"), {"v": crypto.encrypt(value), "id": row_id}
                )
            done += len(rows)
    if done:
        log.info("Zaszyfrowano %d sekretów zapisanych wcześniej jawnym tekstem", done)
    return done


async def init_db(retention_days: int | None = None) -> bool:
    """Migruje schemat do najnowszej wersji, zakłada hypertables i agregaty godzinowe (idempotentnie).

    Zwraca True, jeśli TimescaleDB jest aktywne."""
    retention_days = retention_days or settings.retention_days
    versions = await update_timescale_extension()
    if versions:
        log.info("Rozszerzenie TimescaleDB w bazie: %s (obraz: %s)", *versions)
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
        await encrypt_existing(conn)
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
            compressed = await compression.ensure(conn, HYPERTABLES, retention_days, settings.compress_after_days)
            if compressed:
                log.info(
                    "Kompresja metryk starszych niż %d dni: %d tabel",
                    compression.compress_after_days(retention_days, settings.compress_after_days),
                    len(compressed),
                )
    if timescale:
        await aggregates.ensure(engine, retention_days, settings.aggregate_retention_days)
    log.info("Schemat bazy gotowy (TimescaleDB: %s)", "tak" if timescale else "nie")
    return timescale


__all__ = ["SchemaMismatchError", "Session", "encrypt_existing", "engine", "has_timescale", "init_db", "timescale_available", "missing_columns", "update_timescale_extension"]
