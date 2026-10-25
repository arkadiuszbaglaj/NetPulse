"""Sekrety zaszyfrowane (crypto.py): kolumny community, klucze SNMPv3, klucz API kontrolera i adres webhooka
jako TEXT – zaszyfrowana wartość jest dłuższa niż jawna. Samo szyfrowanie robi init_db (encrypt_existing).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

COLUMNS = (
    ("devices", "community", 255),
    ("devices", "v3_auth_key", 255),
    ("devices", "v3_priv_key", 255),
    ("controllers", "api_key", 255),
    ("notification_channels", "url", 1024),
)


def upgrade() -> None:
    for table, column, _length in COLUMNS:
        op.alter_column(table, column, type_=sa.Text(), existing_nullable=column != "api_key" and column != "url")


def downgrade() -> None:
    # Zaszyfrowane wartości nie mieszczą się w dawnych długościach – cofnięcie wymaga odszyfrowania
    raise NotImplementedError("Cofnięcie migracji 0004 nie jest obsługiwane – użyj kopii bazy sprzed aktualizacji")
