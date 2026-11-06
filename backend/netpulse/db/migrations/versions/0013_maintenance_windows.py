"""Okna serwisowe: planowane prace bez powiadomień i bez wpływu na dostępność; alert z okna (`alerts.maintenance`).

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-06
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "maintenance_windows",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("device_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("days", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("time_from", sa.String(length=5), nullable=True),
        sa.Column("duration_min", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.add_column("alerts", sa.Column("maintenance", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("alerts", "maintenance")
    op.drop_table("maintenance_windows")
