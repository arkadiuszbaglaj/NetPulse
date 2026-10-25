"""Migracje schematu (Alembic) uruchamiane z aplikacji – bez alembic.ini i bez osobnego polecenia.

`init_db` wywołuje `upgrade()` na swoim połączeniu, więc migracje, sprawdzenie schematu i hypertables
idą w jednej transakcji (DDL w PostgreSQL jest transakcyjne – nieudana migracja niczego nie zostawia).
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
# Stały klucz blokady: kolektor i polecenia CLI nie migrują bazy jednocześnie
LOCK_KEY = 0x4E50_4442  # "NPDB"


def alembic_config(connection=None) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.attributes["connection"] = connection
    return cfg


def include_object(obj, name, type_, reflected, compare_to) -> bool:
    """Pomija przy porównaniu indeksy, które TimescaleDB dokłada sam do hypertables (np. `*_time_idx`)."""
    return not (type_ == "index" and reflected and compare_to is None)


def head_revision() -> str:
    return ScriptDirectory.from_config(alembic_config()).get_current_head()


def current_revision(sync_conn) -> str | None:
    return MigrationContext.configure(sync_conn).get_current_revision()


def upgrade(sync_conn) -> None:
    """Doprowadza schemat do najnowszej wersji (do użycia w `conn.run_sync`)."""
    command.upgrade(alembic_config(sync_conn), "head")
