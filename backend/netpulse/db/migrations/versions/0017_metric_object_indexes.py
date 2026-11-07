"""Indeksy (obiekt, czas) na tabelach metryk: wykres jednego portu i ostatni odczyt bez czytania wszystkich obiektów.

Klucz główny tych hypertables zaczyna się od czasu, więc zapytanie o jeden port (urządzenie, sieć WiFi …) w oknie
czytało wiersze wszystkich obiektów z tego okna. Pozostałe tabele metryk (`metrics`, `wan_link_metrics`,
`check_metrics`, `client_metrics`) mają taki indeks od początku. `IF NOT EXISTS`: baza założona z modeli (np. stara instalacja sprzed migracji,
którą przejmuje 0001) może już mieć te indeksy.

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-07
"""

from __future__ import annotations

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

INDEXES = (
    ("ix_interface_metrics_interface_time", "interface_metrics", ["interface_id", "time"]),
    ("ix_device_metrics_device_time", "device_metrics", ["device_id", "time"]),
    ("ix_wifi_metrics_wifi_time", "wifi_metrics", ["wifi_id", "time"]),
    ("ix_disk_metrics_device_time", "disk_metrics", ["device_id", "time"]),
    ("ix_server_metrics_device_time", "server_metrics", ["device_id", "time"]),
    ("ix_poe_port_metrics_device_port_time", "poe_port_metrics", ["device_id", "port_idx", "time"]),
)


def upgrade() -> None:
    for name, table, columns in INDEXES:
        op.create_index(name, table, columns, unique=False, if_not_exists=True)


def downgrade() -> None:
    for name, table, _ in reversed(INDEXES):
        op.drop_index(name, table_name=table, if_exists=True)
