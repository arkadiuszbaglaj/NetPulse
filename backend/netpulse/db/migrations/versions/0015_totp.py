"""Logowanie dwuskładnikowe (TOTP) i kody zapasowe na koncie.

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-06
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("totp_secret", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("totp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("users", sa.Column("totp_last_step", sa.BigInteger(), nullable=True))
    op.add_column("users", sa.Column("totp_recovery", postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "totp_recovery")
    op.drop_column("users", "totp_last_step")
    op.drop_column("users", "totp_enabled")
    op.drop_column("users", "totp_secret")
