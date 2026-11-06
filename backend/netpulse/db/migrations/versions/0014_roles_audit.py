"""Role kont (admin / operator / viewer) i dziennik audytu.

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-06
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("role", sa.String(length=16), nullable=False, server_default="admin"))
    # Dotychczasowe konta: administrator zostaje administratorem, reszta (jeśli była) dostaje podgląd
    op.execute("UPDATE users SET role = CASE WHEN is_admin THEN 'admin' ELSE 'viewer' END")
    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("ip", sa.String(length=64), nullable=True),
        sa.Column("action", sa.String(length=96), nullable=False),
        sa.Column("target", sa.String(length=255), nullable=True),
        sa.Column("status", sa.Integer(), nullable=True),
        sa.Column("detail", sa.String(length=255), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_log_time", "audit_log", ["time"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_audit_log_time", table_name="audit_log")
    op.drop_table("audit_log")
    op.drop_column("users", "role")
