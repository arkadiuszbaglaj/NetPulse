"""Sprawdzanie dostępności: ping, HTTP(S) i port TCP z historią wyników.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-28
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "checks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("target", sa.String(length=512), nullable=False),
        sa.Column("port", sa.Integer(), nullable=True),
        sa.Column("interval_s", sa.Integer(), nullable=False),
        sa.Column("timeout_s", sa.Float(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("expect_status", sa.String(length=32), nullable=True),
        sa.Column("keyword", sa.String(length=255), nullable=True),
        sa.Column("verify_tls", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("status_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_ok_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(length=255), nullable=True),
        sa.Column("last_latency_ms", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    # Hypertable i retencję zakłada init_db (lista HYPERTABLES)
    op.create_table(
        "check_metrics",
        sa.Column("time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("check_id", sa.Integer(), nullable=False),
        sa.Column("up", sa.Boolean(), nullable=False),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("loss_percent", sa.Float(), nullable=True),
        sa.Column("jitter_ms", sa.Float(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("cert_days", sa.Float(), nullable=True),
        sa.ForeignKeyConstraint(["check_id"], ["checks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("time", "check_id"),
    )
    op.create_index("ix_check_metrics_check_time", "check_metrics", ["check_id", "time"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_check_metrics_check_time", table_name="check_metrics")
    op.drop_table("check_metrics")
    op.drop_table("checks")
