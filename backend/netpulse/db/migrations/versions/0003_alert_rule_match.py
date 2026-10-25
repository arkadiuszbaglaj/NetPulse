"""Reguły alertów: filtr nazwy kontenera, usługi albo dysku (`alert_rules.match`).

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("alert_rules", sa.Column("match", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("alert_rules", "match")
