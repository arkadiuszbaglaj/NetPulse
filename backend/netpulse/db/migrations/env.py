"""Środowisko Alembic.

W aplikacji połączenie przekazuje `netpulse.db.migrate` (config.attributes["connection"]). Bez niego
(polecenie `alembic` uruchamiane przez programistę, np. `alembic revision --autogenerate`) łączymy się
sami według NETPULSE_DATABASE_URL.
"""

from __future__ import annotations

import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from netpulse.config import settings
from netpulse.db.migrate import include_object
from netpulse.db.models import Base


def run_migrations(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=Base.metadata,
        include_object=include_object,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_standalone() -> None:
    engine = create_async_engine(settings.database_url, poolclass=NullPool)
    async with engine.begin() as conn:
        await conn.run_sync(run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    raise SystemExit("NetPulse nie obsługuje migracji offline (--sql)")

connection = context.config.attributes.get("connection")
if connection is not None:
    run_migrations(connection)
else:
    asyncio.run(run_standalone())
