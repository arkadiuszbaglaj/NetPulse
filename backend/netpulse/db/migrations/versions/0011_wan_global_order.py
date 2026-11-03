"""Kolejność łączy WAN wspólna dla wszystkich routerów (WAN 1 = łącze główne, także gdy łącza są na różnych routerach).

Wcześniej `position` liczono osobno dla każdego routera, więc łącza dwóch routerów miały obie pozycję 1.
Bez zmian w schemacie – tylko nowa numeracja: dotychczasowa pozycja, potem nazwa łącza.

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-03
"""

from __future__ import annotations

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE wan_links AS w SET position = o.n
        FROM (SELECT id, row_number() OVER (ORDER BY position, name, id) AS n FROM wan_links) AS o
        WHERE w.id = o.id
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE wan_links AS w SET position = o.n
        FROM (SELECT id, row_number() OVER (PARTITION BY device_id ORDER BY position, id) AS n FROM wan_links) AS o
        WHERE w.id = o.id
        """
    )
