"""Stan serwera NetPulse: bieżące wartości i wykresy (próbki zapisuje kolektor, patrz sysinfo.py)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from ..config import settings
from ..db import Session
from ..db.models import SystemMetric
from .metrics import MinutesQuery, _series
from .schemas import Point
from .security import require_user

router = APIRouter(prefix="/api/system", tags=["serwer"], dependencies=[Depends(require_user)])

# Starsza próbka niż to oznacza, że kolektor przestał ją zapisywać
CURRENT_WINDOW = timedelta(minutes=5)

SERIES_COLUMNS = [
    "cpu_percent",
    "mem_used_percent",
    "swap_used_percent",
    "disk_used_percent",
    "load1",
    "load5",
    "load15",
    "temp_c",
    "db_size_bytes",
]


class SystemOut(BaseModel):
    sampled_at: datetime
    cpu_percent: float | None
    load1: float | None
    load5: float | None
    load15: float | None
    mem_used_percent: float | None
    mem_total_bytes: int | None
    swap_used_percent: float | None
    disk_used_percent: float | None
    disk_free_bytes: int | None
    disk_total_bytes: int | None
    uptime_s: float | None
    temp_c: float | None
    db_size_bytes: int | None
    poll_interval_s: int


@router.get("", response_model=SystemOut | None)
async def current():
    """Ostatnia próbka stanu serwera albo null, gdy kolektor jej jeszcze nie zapisał (albo przestał)."""
    since = datetime.now(UTC) - CURRENT_WINDOW
    async with Session() as session:
        row = await session.scalar(
            select(SystemMetric).where(SystemMetric.time >= since).order_by(SystemMetric.time.desc()).limit(1)
        )
    if row is None:
        return None
    values = {c.name: getattr(row, c.name) for c in SystemMetric.__table__.columns if c.name != "time"}
    return SystemOut(sampled_at=row.time, poll_interval_s=settings.poll_interval, **values)


@router.get("/metrics", response_model=list[Point])
async def metrics(minutes: int = MinutesQuery):
    return await _series(SystemMetric, None, None, SERIES_COLUMNS, minutes)
