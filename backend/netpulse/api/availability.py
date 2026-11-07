"""Dostępność (uptime) urządzeń i portów w procentach, np. „switch 99,98% w 30 dni”.

Źródło: próbki kolektora (`device_metrics.reachable`, `interface_metrics.oper_up`), przy TimescaleDB z agregatów
godzinowych (aggregates.py), więc okres może sięgać roku wstecz, choć surowe dane trzymamy 30 dni.
Dni liczone w strefie czasowej instalacji (zmienna TZ). Od 0.60.0 czas okien serwisowych (maintenance.py) nie liczy się
wcale: ich próbki odejmujemy od wyniku (z surowych tabel, więc okna starsze niż retencja surowych danych zostają w wyniku)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, text

from .. import maintenance
from ..config import settings
from ..db import Session, timescale_available
from ..db.models import Device, Interface
from .security import require_user

router = APIRouter(prefix="/api", tags=["dostępność"], dependencies=[Depends(require_user)])

DaysQuery = Query(30, ge=1, le=366, description="okres wstecz w dniach")

# (agregat godzinowy, tabela surowa, kolumna obiektu, suma próbek w agregacie, próbki „działa” w agregacie,
#  liczba próbek w surowej tabeli, próbki „działa” w surowej tabeli)
_SOURCES = {
    "device": ("device_metrics_1h", "device_metrics", "device_id", "samples", "up_samples", "count(*)", "count(*) FILTER (WHERE reachable)"),
    "interface": (
        "interface_metrics_1h",
        "interface_metrics",
        "interface_id",
        "state_samples",
        "up_samples",
        "count(oper_up)",
        "count(*) FILTER (WHERE oper_up)",
    ),
}


class DayOut(BaseModel):
    day: date
    percent: float | None
    samples: int


class AvailabilityOut(BaseModel):
    days: int
    percent: float | None  # None = brak próbek w okresie
    samples: int
    # Przybliżony czas niedostępności: próbki bez odpowiedzi × interwał odpytywania
    down_s: int
    daily: list[DayOut]
    # Pominięty czas okien serwisowych (próbki × interwał) – od 0.60.0
    maintenance_s: int = 0


class DeviceAvailabilityOut(BaseModel):
    device_id: int
    percent: float | None
    samples: int


def _percent(total: int, up: int) -> float | None:
    return up * 100.0 / total if total else None


def _sql(kind: str, timescale: bool, *, per_day: bool) -> str:
    view, raw, key, agg_total, agg_up, raw_total, raw_up = _SOURCES[kind]
    if timescale:
        src, time_col, total, up = view, "bucket", f"sum({agg_total})", f"sum({agg_up})"
    else:
        src, time_col, total, up = raw, "time", raw_total, raw_up
    if per_day:
        return (
            f"SELECT (date_trunc('day', {time_col} AT TIME ZONE :tz))::date AS day, {total} AS total, {up} AS up "
            f"FROM {src} WHERE {key} = :id AND {time_col} >= :since GROUP BY 1 ORDER BY 1"
        )
    return f"SELECT {key}, {total} AS total, {up} AS up FROM {src} WHERE {time_col} >= :since GROUP BY {key}"


def _excluded_sql(kind: str, *, per_day: bool) -> str:
    """Próbki z okien serwisowych: surowa tabela złączona z listą przedziałów (obiekt, początek, koniec)."""
    _, raw, key, _, _, raw_total, raw_up = _SOURCES[kind]
    first = "(date_trunc('day', m.time AT TIME ZONE :tz))::date" if per_day else f"m.{key}"
    return (
        f"SELECT {first} AS k, {raw_total} AS total, {raw_up} AS up FROM {raw} m "
        "JOIN unnest(CAST(:objs AS integer[]), CAST(:starts AS timestamptz[]), CAST(:ends AS timestamptz[])) AS w(obj, s, e) "
        f"ON m.{key} = w.obj AND m.time >= w.s AND m.time < w.e GROUP BY 1"
    )


async def _excluded(session, kind: str, spans: dict[int, list[tuple[datetime, datetime]]], *, per_day: bool) -> dict:
    """{dzień albo obiekt: (próbki, próbki „działa”)} z okien serwisowych; `spans` = obiekt → scalone przedziały."""
    rows = [(obj, s, e) for obj, items in spans.items() for s, e in items]
    if not rows:
        return {}
    params = {"objs": [r[0] for r in rows], "starts": [r[1] for r in rows], "ends": [r[2] for r in rows], "tz": settings.timezone}
    result = (await session.execute(text(_excluded_sql(kind, per_day=per_day)), params)).all()
    return {r.k: (int(r.total), int(r.up)) for r in result}


async def _timescale() -> bool:
    return await timescale_available()


async def availability(kind: str, obj_id: int, days: int) -> AvailabilityOut:
    """Dostępność jednego urządzenia albo portu: łącznie i dzień po dniu."""
    now = datetime.now(UTC)
    since = now - timedelta(days=days)
    sql = _sql(kind, await _timescale(), per_day=True)
    async with Session() as session:
        rows = (await session.execute(text(sql), {"id": obj_id, "since": since, "tz": settings.timezone})).all()
        device_id = obj_id if kind == "device" else await session.scalar(select(Interface.device_id).where(Interface.id == obj_id))
        windows = await maintenance.load(session)
        spans = maintenance.spans_for(windows, device_id, since, now) if device_id is not None else []
        skip = await _excluded(session, kind, {obj_id: spans}, per_day=True)
    daily, total, up, skipped = [], 0, 0, 0
    for r in rows:
        s_total, s_up = skip.get(r.day, (0, 0))
        d_total, d_up = max(0, int(r.total) - s_total), max(0, int(r.up) - s_up)
        total, up, skipped = total + d_total, up + d_up, skipped + s_total
        daily.append(DayOut(day=r.day, percent=_percent(d_total, d_up), samples=d_total))
    return AvailabilityOut(
        days=days,
        percent=_percent(total, up),
        samples=total,
        down_s=(total - up) * settings.poll_interval,
        daily=daily,
        maintenance_s=skipped * settings.poll_interval,
    )


async def devices_availability(days: int) -> list[DeviceAvailabilityOut]:
    """Dostępność wszystkich urządzeń jednym zapytaniem (karty urządzeń na pulpicie)."""
    now = datetime.now(UTC)
    since = now - timedelta(days=days)
    sql = _sql("device", await _timescale(), per_day=False)
    async with Session() as session:
        rows = (await session.execute(text(sql), {"since": since})).all()
        windows = await maintenance.load(session)
        spans = {r[0]: maintenance.spans_for(windows, r[0], since, now) for r in rows} if windows else {}
        skip = await _excluded(session, "device", spans, per_day=False)
    out = []
    for r in rows:
        s_total, s_up = skip.get(r[0], (0, 0))
        total, up = max(0, int(r.total) - s_total), max(0, int(r.up) - s_up)
        out.append(DeviceAvailabilityOut(device_id=r[0], percent=_percent(total, up), samples=total))
    return out


@router.get("/availability", response_model=list[DeviceAvailabilityOut])
async def all_devices(days: int = DaysQuery):
    return await devices_availability(days)


@router.get("/devices/{device_id}/availability", response_model=AvailabilityOut)
async def device_availability(device_id: int, days: int = DaysQuery):
    async with Session() as session:
        if await session.get(Device, device_id) is None:
            raise HTTPException(404, "Nie ma takiego urządzenia")
    return await availability("device", device_id, days)


@router.get("/interfaces/{interface_id}/availability", response_model=AvailabilityOut)
async def interface_availability(interface_id: int, days: int = DaysQuery):
    """Ile czasu port był podłączony (oper up) – próbki bez znanego stanu nie liczą się wcale."""
    async with Session() as session:
        if await session.get(Interface, interface_id) is None:
            raise HTTPException(404, "Nie ma takiego portu")
    return await availability("interface", interface_id, days)
