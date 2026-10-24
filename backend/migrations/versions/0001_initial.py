"""Initial schema: devices, interfaces and metric hypertables.

Revision ID: 0001
Revises:
Create Date: 2026-10-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Raw samples (every 30 s) are kept this long; older chunks are dropped automatically.
RETENTION = "90 days"
# Chunks older than this are compressed (roughly 10-20x less disk space).
COMPRESS_AFTER = "7 days"


def timestamps() -> list[sa.Column]:
    return [
        sa.Column(name, sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False)
        for name in ("created_at", "updated_at")
    ]


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")

    op.create_table(
        "devices",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("host", sa.String(255), nullable=False, unique=True),
        sa.Column("enabled", sa.Boolean, server_default="true", nullable=False),
        sa.Column("snmp_version", sa.String(3), server_default="v2c", nullable=False),
        sa.Column("snmp_port", sa.Integer, server_default="161", nullable=False),
        sa.Column("snmp_community", sa.String(255)),
        sa.Column("snmp_username", sa.String(255)),
        sa.Column("snmp_auth_protocol", sa.String(10)),
        sa.Column("snmp_auth_password", sa.String(255)),
        sa.Column("snmp_priv_protocol", sa.String(10)),
        sa.Column("snmp_priv_password", sa.String(255)),
        sa.Column("snmp_context", sa.String(255)),
        sa.Column("driver", sa.String(50)),
        sa.Column("vendor", sa.String(50)),
        sa.Column("model", sa.String(100)),
        sa.Column("sys_object_id", sa.String(255)),
        sa.Column("sys_descr", sa.Text),
        sa.Column("sys_name", sa.String(255)),
        sa.Column("last_seen_at", sa.DateTime(timezone=True)),
        *timestamps(),
        sa.CheckConstraint("snmp_version IN ('v1', 'v2c', 'v3')", name="snmp_version_valid"),
        sa.CheckConstraint(
            "snmp_auth_protocol IS NULL OR snmp_auth_protocol IN "
            "('MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512')",
            name="snmp_auth_protocol_valid",
        ),
        sa.CheckConstraint(
            "snmp_priv_protocol IS NULL OR snmp_priv_protocol IN "
            "('DES', '3DES', 'AES128', 'AES192', 'AES256')",
            name="snmp_priv_protocol_valid",
        ),
    )

    op.create_table(
        "interfaces",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "device_id",
            sa.Integer,
            sa.ForeignKey("devices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("if_index", sa.Integer, nullable=False),
        sa.Column("name", sa.String(255)),
        sa.Column("descr", sa.String(255)),
        sa.Column("alias", sa.String(255)),
        sa.Column("if_type", sa.Integer),
        sa.Column("mac", sa.String(17)),
        sa.Column("speed_mbps", sa.BigInteger),
        sa.Column("admin_status", sa.SmallInteger),
        sa.Column("oper_status", sa.SmallInteger),
        sa.Column("role", sa.String(20)),
        sa.Column("hidden", sa.Boolean, server_default="false", nullable=False),
        *timestamps(),
        sa.UniqueConstraint("device_id", "if_index"),
    )

    op.create_table(
        "interface_metrics",
        sa.Column("time", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "interface_id",
            sa.Integer,
            sa.ForeignKey("interfaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("in_bps", sa.Double),
        sa.Column("out_bps", sa.Double),
        sa.Column("in_errors", sa.BigInteger),
        sa.Column("out_errors", sa.BigInteger),
        sa.Column("in_discards", sa.BigInteger),
        sa.Column("out_discards", sa.BigInteger),
        sa.Column("oper_status", sa.SmallInteger),
        sa.PrimaryKeyConstraint("interface_id", "time"),
    )

    op.create_table(
        "device_metrics",
        sa.Column("time", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "device_id",
            sa.Integer,
            sa.ForeignKey("devices.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("reachable", sa.Boolean, nullable=False),
        sa.Column("response_ms", sa.Double),
        sa.Column("uptime_s", sa.BigInteger),
        sa.Column("load_1m", sa.Double),
        sa.Column("mem_total_kb", sa.BigInteger),
        sa.Column("mem_available_kb", sa.BigInteger),
        sa.PrimaryKeyConstraint("device_id", "time"),
    )

    for table, segment_by in (
        ("interface_metrics", "interface_id"),
        ("device_metrics", "device_id"),
    ):
        op.execute(f"SELECT create_hypertable('{table}', by_range('time', INTERVAL '1 day'))")
        op.execute(
            f"ALTER TABLE {table} SET (timescaledb.compress, "
            f"timescaledb.compress_segmentby = '{segment_by}', "
            f"timescaledb.compress_orderby = 'time DESC')"
        )
        op.execute(f"SELECT add_compression_policy('{table}', INTERVAL '{COMPRESS_AFTER}')")
        op.execute(f"SELECT add_retention_policy('{table}', INTERVAL '{RETENTION}')")


def downgrade() -> None:
    op.drop_table("device_metrics")
    op.drop_table("interface_metrics")
    op.drop_table("interfaces")
    op.drop_table("devices")
