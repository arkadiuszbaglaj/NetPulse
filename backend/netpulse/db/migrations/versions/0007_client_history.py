"""Historia klientów sieci: znani klienci (`known_clients`, zostają po rozłączeniu) i stan w czasie (`client_metrics`).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "known_clients",
        sa.Column("mac", sa.String(length=17), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=True),
        sa.Column("ip", sa.String(length=45), nullable=True),
        sa.Column("is_wired", sa.Boolean(), nullable=False),
        sa.Column("is_guest", sa.Boolean(), nullable=False),
        sa.Column("essid", sa.String(length=64), nullable=True),
        sa.Column("uplink_device_id", sa.Integer(), nullable=True),
        sa.Column("uplink_name", sa.String(length=128), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["uplink_device_id"], ["devices.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("mac"),
    )
    op.create_index(op.f("ix_known_clients_last_seen_at"), "known_clients", ["last_seen_at"], unique=False)
    # Hypertable i retencję zakłada init_db (lista HYPERTABLES)
    op.create_table(
        "client_metrics",
        sa.Column("time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("mac", sa.String(length=17), nullable=False),
        sa.Column("is_wired", sa.Boolean(), nullable=False),
        sa.Column("signal_dbm", sa.Integer(), nullable=True),
        sa.Column("tx_rate_kbps", sa.Integer(), nullable=True),
        sa.Column("rx_rate_kbps", sa.Integer(), nullable=True),
        sa.Column("uplink_device_id", sa.Integer(), nullable=True),
        sa.Column("uplink_name", sa.String(length=128), nullable=True),
        sa.Column("uplink_port", sa.Integer(), nullable=True),
        sa.Column("essid", sa.String(length=64), nullable=True),
        sa.Column("radio", sa.String(length=8), nullable=True),
        sa.PrimaryKeyConstraint("time", "mac"),
    )
    op.create_index("ix_client_metrics_mac_time", "client_metrics", ["mac", "time"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_client_metrics_mac_time", table_name="client_metrics")
    op.drop_table("client_metrics")
    op.drop_index(op.f("ix_known_clients_last_seen_at"), table_name="known_clients")
    op.drop_table("known_clients")
