"""Prędkość klientów VPN w historii: podział przez 8 (od 0.72.0).

Kontroler UniFi podaje `rx_rate`/`tx_rate` sesji VPN już w bitach/s, a NetPulse od 0.57.0 mnożył je jeszcze ×8 –
wykresy i alerty VPN pokazywały prędkość 8 razy za dużą. Sprawdzone 13.11.2026 na UCG Ultra: 30 MB przez tunel
WireGuard to w kontrolerze 66,8 Mb/s, a w liczniku `wg show` ok. 9 MB/s (72 Mb/s). Poprawka parsera w `unifi.py`;
tu – zapisane wcześniej próbki `vpn_down_bps` i `vpn_up_bps` w `metrics`. TimescaleDB pozwala na UPDATE także
w skompresowanych chunkach.

Revision ID: 0019
Revises: 0018
Create Date: 2026-11-13
"""

from __future__ import annotations

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE metrics SET value = value / 8 WHERE name IN ('vpn_down_bps', 'vpn_up_bps')")


def downgrade() -> None:
    op.execute("UPDATE metrics SET value = value * 8 WHERE name IN ('vpn_down_bps', 'vpn_up_bps')")
