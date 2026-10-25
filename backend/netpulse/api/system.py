"""Stan serwera NetPulse: bieżące wartości i wykresy (próbki zapisuje kolektor, patrz sysinfo.py)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select, text

from .. import __version__
from ..config import settings
from ..db import Session, engine, has_timescale
from ..db.models import Controller, Device, SystemMetric
from .metrics import MinutesQuery, _series
from .schemas import Point
from .security import require_user
from .updates import STATUS_TIMEOUT, _call, _configured, _Unreachable

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


# --- stan usług ---------------------------------------------------------------------------------


class ServiceOut(BaseModel):
    id: str  # api | database | collector | unifi | updater
    state: str  # ok | warn | down | off (wyłączone albo nieskonfigurowane)
    detail: str | None = None


def fresh(last: datetime | None, now: datetime, interval_s: int) -> bool:
    """Czy ostatni zapis kolektora jest świeży (do 3 cykli i 10 s zapasu)."""
    return last is not None and (now - last).total_seconds() <= 3 * interval_s + 10


async def _updater_service() -> ServiceOut:
    if not _configured():
        return ServiceOut(id="updater", state="off", detail="not_configured")
    try:
        code, _ = await _call("GET", "/status", STATUS_TIMEOUT)
    except _Unreachable:
        return ServiceOut(id="updater", state="down", detail="unreachable")
    return ServiceOut(id="updater", state="ok" if code == 200 else "warn", detail=None if code == 200 else f"http_{code}")


@router.get("/services", response_model=list[ServiceOut])
async def services():
    """Stan usług NetPulse: API, baza, kolektory (po świeżości ostatnich zapisów), kontrolery UniFi, updater."""
    now = datetime.now(UTC)
    interval = settings.poll_interval
    out = [ServiceOut(id="api", state="ok", detail=__version__)]

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            timescale = await has_timescale(conn)
        out.append(ServiceOut(id="database", state="ok", detail="timescaledb" if timescale else "postgres"))
    except Exception:
        out.append(ServiceOut(id="database", state="down", detail="unreachable"))
        return out + [ServiceOut(id="collector", state="warn", detail="no_database"), await _updater_service()]

    async with Session() as session:
        last_system = await session.scalar(select(func.max(SystemMetric.time)))
        last_snmp = await session.scalar(select(func.max(Device.last_polled_at)).where(Device.enabled))
        controllers = (await session.scalars(select(Controller).where(Controller.enabled))).all()
    latest = max((t for t in (last_system, last_snmp) if t is not None), default=None)
    if latest is None:
        out.append(ServiceOut(id="collector", state="warn", detail="no_data"))
    elif fresh(latest, now, interval):
        out.append(ServiceOut(id="collector", state="ok"))
    else:
        out.append(ServiceOut(id="collector", state="down", detail="stale"))

    if not controllers:
        out.append(ServiceOut(id="unifi", state="off", detail="not_configured"))
    elif any(c.status == "down" for c in controllers):
        out.append(ServiceOut(id="unifi", state="down", detail=next(c.last_error for c in controllers if c.status == "down")))
    elif all(c.status == "up" and fresh(c.last_polled_at, now, interval) for c in controllers):
        out.append(ServiceOut(id="unifi", state="ok"))
    else:
        out.append(ServiceOut(id="unifi", state="warn", detail="stale"))

    out.append(await _updater_service())
    return out
