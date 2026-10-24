"""Układ pulpitu zapisany na koncie (widgety, ich kolejność, rozmiar i konfiguracja wykresów).

Na razie jeden pulpit domyślny na użytkownika (`/api/dashboards/default`); tabela i schemat są gotowe
na wiele pulpitów. Brak zapisanego układu = panel używa układu domyślnego (nic nie jest zapisywane z góry)."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ValidationError
from sqlalchemy import delete, select, text

from ..db import Session
from ..db.models import Dashboard
from .layout_schemas import SCHEMA_VERSION, DashboardLayout
from .security import CurrentUser, require_user

router = APIRouter(prefix="/api/dashboards", tags=["pulpit"], dependencies=[Depends(require_user)])

# Blokada na użytkownika, żeby dwa równoczesne pierwsze zapisy nie utworzyły dwóch pulpitów domyślnych
_LOCK_BASE = 0x4E50 << 32


class DashboardOut(BaseModel):
    layout: DashboardLayout | None
    updated_at: datetime | None


def _parse(raw: dict | None) -> DashboardLayout | None:
    """Zapisany układ, który przestał pasować do schematu (np. po zmianie wersji), traktujemy jak brak."""
    if not raw:
        return None
    try:
        return DashboardLayout.model_validate(raw)
    except ValidationError:
        return None


async def _default_row(session, user_id: int) -> Dashboard | None:
    return await session.scalar(select(Dashboard).where(Dashboard.owner_id == user_id, Dashboard.is_default.is_(True)))


@router.get("/default", response_model=DashboardOut)
async def get_default(user: CurrentUser):
    async with Session() as session:
        row = await _default_row(session, user.id)
    return DashboardOut(layout=_parse(row.layout) if row else None, updated_at=row.updated_at if row else None)


@router.put("/default", response_model=DashboardOut)
async def put_default(layout: DashboardLayout, user: CurrentUser):
    data = layout.model_dump(mode="json")
    now = datetime.now(UTC)
    async with Session() as session, session.begin():
        await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_BASE + user.id})
        row = await _default_row(session, user.id)
        if row is None:
            row = Dashboard(owner_id=user.id, is_default=True, schema_version=SCHEMA_VERSION, layout=data, updated_at=now)
            session.add(row)
        else:
            row.layout, row.schema_version, row.updated_at = data, SCHEMA_VERSION, now
    return DashboardOut(layout=layout, updated_at=now)


@router.delete("/default", status_code=204)
async def reset_default(user: CurrentUser):
    """Przywraca układ domyślny (usuwa zapisany)."""
    async with Session() as session, session.begin():
        await session.execute(delete(Dashboard).where(Dashboard.owner_id == user.id, Dashboard.is_default.is_(True)))
