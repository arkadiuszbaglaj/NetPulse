"""Łącza WAN routera (dual WAN / failover): konfiguracja i stan (`wan_links`) oraz historia (`wan_link_metrics`).

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wan_links",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.Integer(), nullable=False),
        sa.Column("interface_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("state", sa.String(length=10), nullable=False),
        sa.Column("state_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source", sa.String(length=10), nullable=True),
        sa.Column("ctrl_up", sa.Boolean(), nullable=True),
        sa.Column("ctrl_active", sa.Boolean(), nullable=True),
        sa.Column("ctrl_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["interface_id"], ["interfaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("interface_id"),
    )
    op.create_index(op.f("ix_wan_links_device_id"), "wan_links", ["device_id"], unique=False)
    # Hypertable i retencję zakłada init_db (lista HYPERTABLES)
    op.create_table(
        "wan_link_metrics",
        sa.Column("time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("wan_link_id", sa.Integer(), nullable=False),
        sa.Column("up", sa.Boolean(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("in_bps", sa.Float(), nullable=True),
        sa.Column("out_bps", sa.Float(), nullable=True),
        sa.ForeignKeyConstraint(["wan_link_id"], ["wan_links.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("time", "wan_link_id"),
    )
    op.create_index("ix_wan_link_metrics_link_time", "wan_link_metrics", ["wan_link_id", "time"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_wan_link_metrics_link_time", table_name="wan_link_metrics")
    op.drop_table("wan_link_metrics")
    op.drop_index(op.f("ix_wan_links_device_id"), table_name="wan_links")
    op.drop_table("wan_links")
