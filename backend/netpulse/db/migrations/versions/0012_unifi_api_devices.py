"""Urządzenia UniFi z oficjalnego API (bez SNMP, np. USW Flex i Ultra): powiązanie z urządzeniem NetPulse.

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-04
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "unifi_api_devices",
        sa.Column("controller_id", sa.Integer(), nullable=False),
        sa.Column("mac", sa.String(length=17), nullable=False),
        sa.Column("device_id", sa.Integer(), nullable=True),
        sa.Column("official_id", sa.String(length=64), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["controller_id"], ["controllers.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("controller_id", "mac"),
        sa.UniqueConstraint("device_id"),
    )


def downgrade() -> None:
    op.drop_table("unifi_api_devices")
