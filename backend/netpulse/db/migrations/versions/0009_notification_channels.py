"""Kanały powiadomień: ntfy i e-mail (sekret, konfiguracja SMTP), ciche godziny; alerty wyciszone przez topologię.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("notification_channels", "url", existing_type=sa.Text(), nullable=True)
    op.add_column("notification_channels", sa.Column("secret", sa.Text(), nullable=True))
    op.add_column(
        "notification_channels",
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.add_column("notification_channels", sa.Column("quiet_from", sa.String(length=5), nullable=True))
    op.add_column("notification_channels", sa.Column("quiet_to", sa.String(length=5), nullable=True))
    op.add_column("notification_channels", sa.Column("quiet_critical", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("notification_channels", sa.Column("quiet_backlog", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("alerts", sa.Column("muted", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("alerts", "muted")
    for column in ("quiet_backlog", "quiet_critical", "quiet_to", "quiet_from", "config", "secret"):
        op.drop_column("notification_channels", column)
    op.execute("DELETE FROM notification_channels WHERE url IS NULL")
    op.alter_column("notification_channels", "url", existing_type=sa.Text(), nullable=False)
