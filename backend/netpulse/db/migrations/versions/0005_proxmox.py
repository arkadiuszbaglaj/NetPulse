"""Integracja z Proxmox VE: serwery (token API), węzły, maszyny VM/LXC i magazyny.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # token_secret: tekst zaszyfrowany przez crypto.EncryptedText
    op.create_table('proxmox_servers',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('host', sa.String(length=255), nullable=False),
    sa.Column('port', sa.Integer(), nullable=False),
    sa.Column('token_id', sa.String(length=255), nullable=False),
    sa.Column('token_secret', sa.Text(), nullable=False),
    sa.Column('verify_tls', sa.Boolean(), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('version', sa.String(length=32), nullable=True),
    sa.Column('cluster_name', sa.String(length=128), nullable=True),
    sa.Column('last_polled_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_ok_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('host')
    )
    op.create_table('proxmox_guests',
    sa.Column('server_id', sa.Integer(), nullable=False),
    sa.Column('vmid', sa.Integer(), nullable=False),
    sa.Column('node', sa.String(length=64), nullable=False),
    sa.Column('type', sa.String(length=8), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('template', sa.Boolean(), nullable=False),
    sa.Column('tags', sa.String(length=255), nullable=True),
    sa.Column('cpus', sa.Integer(), nullable=True),
    sa.Column('cpu_percent', sa.Float(), nullable=True),
    sa.Column('mem_used', sa.BigInteger(), nullable=True),
    sa.Column('mem_total', sa.BigInteger(), nullable=True),
    sa.Column('disk_used', sa.BigInteger(), nullable=True),
    sa.Column('disk_total', sa.BigInteger(), nullable=True),
    sa.Column('uptime_s', sa.BigInteger(), nullable=True),
    sa.Column('last_backup_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['server_id'], ['proxmox_servers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('server_id', 'vmid')
    )
    op.create_table('proxmox_nodes',
    sa.Column('server_id', sa.Integer(), nullable=False),
    sa.Column('node', sa.String(length=64), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=True),
    sa.Column('online', sa.Boolean(), nullable=False),
    sa.Column('backup_status', sa.String(length=255), nullable=True),
    sa.Column('backup_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['server_id'], ['proxmox_servers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('server_id', 'node'),
    sa.UniqueConstraint('device_id')
    )
    op.create_table('proxmox_storages',
    sa.Column('server_id', sa.Integer(), nullable=False),
    sa.Column('node', sa.String(length=64), nullable=False),
    sa.Column('storage', sa.String(length=128), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=True),
    sa.Column('shared', sa.Boolean(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('content', sa.String(length=255), nullable=True),
    sa.Column('used_bytes', sa.BigInteger(), nullable=True),
    sa.Column('total_bytes', sa.BigInteger(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['server_id'], ['proxmox_servers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('server_id', 'node', 'storage')
    )


def downgrade() -> None:
    op.drop_table("proxmox_storages")
    op.drop_table("proxmox_nodes")
    op.drop_table("proxmox_guests")
    op.drop_table("proxmox_servers")
