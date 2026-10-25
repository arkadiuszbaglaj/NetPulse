"""Schemat bazy z wersji 0.9.0 (punkt wyjścia migracji).

Instalacje sprzed Alembic mają już te tabele (tworzył je `create_all`), więc tworzymy tylko te, których
brakuje – ta sama migracja działa dla nowej bazy i dla bazy z wersji 0.9.0 i starszych.

Revision ID: 0001
Revises:
Create Date: 2026-10-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

_existing: set[str] = set()


def _create_table(name: str, *args, **kw) -> None:
    if name not in _existing:
        op.create_table(name, *args, **kw)


def _create_index(index_name: str, table: str, *args, **kw) -> None:
    if table not in _existing:
        op.create_index(index_name, table, *args, **kw)


def upgrade() -> None:
    _existing.clear()
    _existing.update(sa.inspect(op.get_bind()).get_table_names())
    _create_table('app_settings',
    sa.Column('key', sa.String(length=64), nullable=False),
    sa.Column('value', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('key')
    )
    _create_table('controllers',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('host', sa.String(length=255), nullable=False),
    sa.Column('port', sa.Integer(), nullable=False),
    sa.Column('api_key', sa.String(length=255), nullable=False),
    sa.Column('site', sa.String(length=64), nullable=False),
    sa.Column('verify_tls', sa.Boolean(), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('app_version', sa.String(length=32), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('last_polled_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_ok_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('host')
    )
    _create_table('devices',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('host', sa.String(length=255), nullable=False),
    sa.Column('port', sa.Integer(), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('driver', sa.String(length=32), nullable=False),
    sa.Column('snmp_version', sa.String(length=4), nullable=False),
    sa.Column('community', sa.String(length=255), nullable=True),
    sa.Column('v3_username', sa.String(length=128), nullable=True),
    sa.Column('v3_auth_protocol', sa.String(length=16), nullable=True),
    sa.Column('v3_auth_key', sa.String(length=255), nullable=True),
    sa.Column('v3_priv_protocol', sa.String(length=16), nullable=True),
    sa.Column('v3_priv_key', sa.String(length=255), nullable=True),
    sa.Column('v3_context', sa.String(length=128), nullable=True),
    sa.Column('detected_driver', sa.String(length=32), nullable=True),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('vendor', sa.String(length=64), nullable=True),
    sa.Column('model', sa.String(length=64), nullable=True),
    sa.Column('firmware', sa.String(length=64), nullable=True),
    sa.Column('sys_name', sa.String(length=255), nullable=True),
    sa.Column('sys_descr', sa.Text(), nullable=True),
    sa.Column('sys_object_id', sa.String(length=255), nullable=True),
    sa.Column('uptime_s', sa.Float(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('last_polled_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_ok_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('host')
    )
    _create_table('notification_channels',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('url', sa.String(length=1024), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('min_severity', sa.String(length=10), nullable=False),
    sa.Column('notify_resolved', sa.Boolean(), nullable=False),
    sa.Column('last_status', sa.String(length=8), nullable=True),
    sa.Column('last_error', sa.Text(), nullable=True),
    sa.Column('last_sent_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    _create_table('system_metrics',
    sa.Column('time', sa.DateTime(timezone=True), nullable=False),
    sa.Column('cpu_percent', sa.Float(), nullable=True),
    sa.Column('load1', sa.Float(), nullable=True),
    sa.Column('load5', sa.Float(), nullable=True),
    sa.Column('load15', sa.Float(), nullable=True),
    sa.Column('mem_used_percent', sa.Float(), nullable=True),
    sa.Column('mem_total_bytes', sa.BigInteger(), nullable=True),
    sa.Column('swap_used_percent', sa.Float(), nullable=True),
    sa.Column('disk_used_percent', sa.Float(), nullable=True),
    sa.Column('disk_free_bytes', sa.BigInteger(), nullable=True),
    sa.Column('disk_total_bytes', sa.BigInteger(), nullable=True),
    sa.Column('uptime_s', sa.Float(), nullable=True),
    sa.Column('temp_c', sa.Float(), nullable=True),
    sa.Column('db_size_bytes', sa.BigInteger(), nullable=True),
    sa.PrimaryKeyConstraint('time')
    )
    _create_table('users',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('is_admin', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('username')
    )
    _create_table('alert_rules',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('kind', sa.String(length=24), nullable=False),
    sa.Column('metric', sa.String(length=32), nullable=True),
    sa.Column('op', sa.String(length=2), nullable=True),
    sa.Column('threshold', sa.Float(), nullable=True),
    sa.Column('duration_s', sa.Integer(), nullable=False),
    sa.Column('severity', sa.String(length=10), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    _create_index(op.f('ix_alert_rules_device_id'), 'alert_rules', ['device_id'], unique=False)
    _create_table('auth_sessions',
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=True),
    sa.Column('user_agent', sa.String(length=255), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('token_hash')
    )
    _create_index(op.f('ix_auth_sessions_user_id'), 'auth_sessions', ['user_id'], unique=False)
    _create_table('dashboards',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('owner_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('is_default', sa.Boolean(), nullable=False),
    sa.Column('schema_version', sa.Integer(), nullable=False),
    sa.Column('layout', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    _create_index(op.f('ix_dashboards_owner_id'), 'dashboards', ['owner_id'], unique=False)
    _create_table('device_metrics',
    sa.Column('time', sa.DateTime(timezone=True), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('reachable', sa.Boolean(), nullable=False),
    sa.Column('poll_ms', sa.Float(), nullable=True),
    sa.Column('uptime_s', sa.Float(), nullable=True),
    sa.Column('cpu_percent', sa.Float(), nullable=True),
    sa.Column('mem_used_percent', sa.Float(), nullable=True),
    sa.Column('load1', sa.Float(), nullable=True),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('time', 'device_id')
    )
    _create_table('disk_metrics',
    sa.Column('time', sa.DateTime(timezone=True), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('mount', sa.String(length=255), nullable=False),
    sa.Column('total_bytes', sa.BigInteger(), nullable=False),
    sa.Column('used_bytes', sa.BigInteger(), nullable=False),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('time', 'device_id', 'mount')
    )
    _create_table('interfaces',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('if_index', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('descr', sa.String(length=255), nullable=True),
    sa.Column('alias', sa.String(length=255), nullable=True),
    sa.Column('label', sa.String(length=128), nullable=False),
    sa.Column('if_type', sa.Integer(), nullable=True),
    sa.Column('mac', sa.String(length=17), nullable=True),
    sa.Column('role', sa.String(length=16), nullable=False),
    sa.Column('hidden', sa.Boolean(), nullable=False),
    sa.Column('admin_up', sa.Boolean(), nullable=True),
    sa.Column('oper_status', sa.String(length=16), nullable=False),
    sa.Column('speed_mbps', sa.Integer(), nullable=True),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('device_id', 'if_index')
    )
    _create_index(op.f('ix_interfaces_device_id'), 'interfaces', ['device_id'], unique=False)
    _create_table('network_clients',
    sa.Column('controller_id', sa.Integer(), nullable=False),
    sa.Column('mac', sa.String(length=17), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=True),
    sa.Column('ip', sa.String(length=45), nullable=True),
    sa.Column('is_wired', sa.Boolean(), nullable=False),
    sa.Column('is_guest', sa.Boolean(), nullable=False),
    sa.Column('essid', sa.String(length=64), nullable=True),
    sa.Column('radio', sa.String(length=8), nullable=True),
    sa.Column('signal_dbm', sa.Integer(), nullable=True),
    sa.Column('tx_rate_kbps', sa.Integer(), nullable=True),
    sa.Column('rx_rate_kbps', sa.Integer(), nullable=True),
    sa.Column('uplink_device_id', sa.Integer(), nullable=True),
    sa.Column('uplink_name', sa.String(length=128), nullable=True),
    sa.Column('uplink_port', sa.Integer(), nullable=True),
    sa.Column('connected_s', sa.Integer(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['controller_id'], ['controllers.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['uplink_device_id'], ['devices.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('controller_id', 'mac')
    )
    _create_index(op.f('ix_network_clients_uplink_device_id'), 'network_clients', ['uplink_device_id'], unique=False)
    _create_table('poe_budget_metrics',
    sa.Column('time', sa.DateTime(timezone=True), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('used_w', sa.Float(), nullable=True),
    sa.Column('max_w', sa.Float(), nullable=True),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('time', 'device_id')
    )
    _create_table('poe_port_metrics',
    sa.Column('time', sa.DateTime(timezone=True), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('port_idx', sa.Integer(), nullable=False),
    sa.Column('power_w', sa.Float(), nullable=True),
    sa.Column('voltage_v', sa.Float(), nullable=True),
    sa.Column('current_ma', sa.Float(), nullable=True),
    sa.Column('poe_mode', sa.String(length=16), nullable=True),
    sa.Column('poe_class', sa.String(length=16), nullable=True),
    sa.Column('delivering', sa.Boolean(), nullable=True),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('time', 'device_id', 'port_idx')
    )
    _create_table('server_metrics',
    sa.Column('time', sa.DateTime(timezone=True), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('swap_used_percent', sa.Float(), nullable=True),
    sa.Column('processes', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('time', 'device_id')
    )
    _create_table('topology_links',
    sa.Column('controller_id', sa.Integer(), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('local_port_idx', sa.Integer(), nullable=False),
    sa.Column('remote_mac', sa.String(length=17), nullable=False),
    sa.Column('local_mac', sa.String(length=17), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['controller_id'], ['controllers.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('controller_id', 'device_id', 'local_port_idx', 'remote_mac')
    )
    _create_table('user_preferences',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id')
    )
    _create_table('wifi_networks',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('key', sa.String(length=64), nullable=False),
    sa.Column('ssid', sa.String(length=64), nullable=False),
    sa.Column('radio', sa.String(length=16), nullable=True),
    sa.Column('channel', sa.Integer(), nullable=True),
    sa.Column('bssid', sa.String(length=17), nullable=True),
    sa.Column('hidden', sa.Boolean(), nullable=False),
    sa.Column('clients', sa.Integer(), nullable=True),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('device_id', 'key')
    )
    _create_index(op.f('ix_wifi_networks_device_id'), 'wifi_networks', ['device_id'], unique=False)
    _create_table('alerts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('rule_id', sa.Integer(), nullable=True),
    sa.Column('subject', sa.String(length=64), nullable=False),
    sa.Column('state', sa.String(length=10), nullable=False),
    sa.Column('severity', sa.String(length=10), nullable=False),
    sa.Column('title', sa.String(length=255), nullable=False),
    sa.Column('message', sa.Text(), nullable=True),
    sa.Column('device_id', sa.Integer(), nullable=True),
    sa.Column('value', sa.Float(), nullable=True),
    sa.Column('peak', sa.Float(), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('acked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('acked_by', sa.String(length=64), nullable=True),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['rule_id'], ['alert_rules.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    _create_index(op.f('ix_alerts_device_id'), 'alerts', ['device_id'], unique=False)
    _create_index(op.f('ix_alerts_rule_id'), 'alerts', ['rule_id'], unique=False)
    _create_index(op.f('ix_alerts_state'), 'alerts', ['state'], unique=False)
    _create_table('interface_metrics',
    sa.Column('time', sa.DateTime(timezone=True), nullable=False),
    sa.Column('interface_id', sa.Integer(), nullable=False),
    sa.Column('in_bps', sa.Float(), nullable=True),
    sa.Column('out_bps', sa.Float(), nullable=True),
    sa.Column('in_errors', sa.BigInteger(), nullable=True),
    sa.Column('out_errors', sa.BigInteger(), nullable=True),
    sa.Column('in_discards', sa.BigInteger(), nullable=True),
    sa.Column('out_discards', sa.BigInteger(), nullable=True),
    sa.Column('oper_up', sa.Boolean(), nullable=True),
    sa.ForeignKeyConstraint(['interface_id'], ['interfaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('time', 'interface_id')
    )
    _create_table('wifi_metrics',
    sa.Column('time', sa.DateTime(timezone=True), nullable=False),
    sa.Column('wifi_id', sa.Integer(), nullable=False),
    sa.Column('clients', sa.Integer(), nullable=True),
    sa.Column('rx_bps', sa.Float(), nullable=True),
    sa.Column('tx_bps', sa.Float(), nullable=True),
    sa.ForeignKeyConstraint(['wifi_id'], ['wifi_networks.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('time', 'wifi_id')
    )


def downgrade() -> None:
    raise NotImplementedError("Cofnięcie schematu bazowego oznacza utratę danych – użyj: netpulse reset")
