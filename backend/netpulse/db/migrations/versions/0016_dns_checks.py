"""Sprawdzenie DNS: typ rekordu, serwer i ostatnia odpowiedź.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-06
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("checks", sa.Column("dns_type", sa.String(length=8), nullable=True))
    op.add_column("checks", sa.Column("dns_server", sa.String(length=255), nullable=True))
    op.add_column("checks", sa.Column("last_answer", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("checks", "last_answer")
    op.drop_column("checks", "dns_server")
    op.drop_column("checks", "dns_type")
