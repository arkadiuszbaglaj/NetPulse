"""Szczyt ruchu portu w cyklu kolektora: `interface_metrics.in_bps_max` i `out_bps_max` (od 0.70.0).

Dwie osobne instrukcje ALTER – tabela ma włączoną kompresję TimescaleDB (0.67.0), a do skompresowanej hypertable
dodaje się kolumny pojedynczo, bez wartości domyślnej. Sprawdzone 12.11.2026 na prawdziwej bazie ze
skompresowanymi chunkami (transakcja wycofana).

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-12
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("interface_metrics", sa.Column("in_bps_max", sa.Float(), nullable=True))
    op.add_column("interface_metrics", sa.Column("out_bps_max", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("interface_metrics", "out_bps_max")
    op.drop_column("interface_metrics", "in_bps_max")
