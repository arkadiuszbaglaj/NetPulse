"""Publiczne pulpity: token w adresie /p/<token> (skrót i zaszyfrowana wartość), wygaśnięcie, PIN i opcje.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("dashboards", sa.Column("public_token_hash", sa.String(length=64), nullable=True))
    op.add_column("dashboards", sa.Column("public_token", sa.Text(), nullable=True))
    op.add_column("dashboards", sa.Column("public_expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("dashboards", sa.Column("public_pin_hash", sa.String(length=255), nullable=True))
    op.add_column("dashboards", sa.Column("public_options", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.create_unique_constraint("dashboards_public_token_hash_key", "dashboards", ["public_token_hash"])


def downgrade() -> None:
    op.drop_constraint("dashboards_public_token_hash_key", "dashboards", type_="unique")
    for column in ("public_options", "public_pin_hash", "public_expires_at", "public_token", "public_token_hash"):
        op.drop_column("dashboards", column)
