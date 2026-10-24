"""Szeregi czasowe metryk do wykresów."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, text

from ..db import Session, engine, has_timescale
from ..db.models import Device, DeviceMetric, Interface, InterfaceMetric, WifiMetric, WifiNetwork
from .schemas import Point
from .security import require_user

router = APIRouter(prefix="/api", tags=["metryki"], dependencies=[Depends(require_user)])

MinutesQuery = Query(60, ge=5, le=60 * 24 * 30, description="zakres wstecz w minutach")


def _bucket_seconds(minutes: int) -> int:
    """Rozmiar kubełka tak, żeby wykres miał ~300 punktów, nie mniej niż 30 s."""
    return max(30, (minutes * 60) // 300)


async def _series(model, id_col, obj_id: int, columns: list[str], minutes: int) -> list[Point]:
    since = datetime.now(UTC) - timedelta(minutes=minutes)
    async with Session() as session:
        async with engine.connect() as conn:
            timescale = await has_timescale(conn)
        cols = [getattr(model, c) for c in columns]
        if timescale:
            bucket = func.time_bucket(text(f"INTERVAL '{_bucket_seconds(minutes)} seconds'"), model.time)
            stmt = (
                select(bucket.label("bucket"), *[func.avg(c).label(c.key) for c in cols])
                .where(id_col == obj_id, model.time >= since)
                .group_by("bucket")
                .order_by("bucket")
            )
        else:
            stmt = (
                select(model.time.label("bucket"), *cols)
                .where(id_col == obj_id, model.time >= since)
                .order_by(model.time)
            )
        rows = (await session.execute(stmt)).all()
    return [
        Point(time=r[0], values={c: (float(v) if v is not None else None) for c, v in zip(columns, r[1:], strict=True)})
        for r in rows
    ]


async def _exists(model, obj_id: int, what: str) -> None:
    async with Session() as session:
        if await session.get(model, obj_id) is None:
            raise HTTPException(404, f"Nie ma takiego obiektu: {what}")


@router.get("/devices/{device_id}/metrics", response_model=list[Point])
async def device_metrics(device_id: int, minutes: int = MinutesQuery):
    await _exists(Device, device_id, "urządzenie")
    return await _series(
        DeviceMetric,
        DeviceMetric.device_id,
        device_id,
        ["cpu_percent", "mem_used_percent", "load1", "poll_ms"],
        minutes,
    )


@router.get("/interfaces/{interface_id}/metrics", response_model=list[Point])
async def interface_metrics(interface_id: int, minutes: int = MinutesQuery):
    await _exists(Interface, interface_id, "port")
    return await _series(
        InterfaceMetric,
        InterfaceMetric.interface_id,
        interface_id,
        ["in_bps", "out_bps", "in_errors", "out_errors", "in_discards", "out_discards"],
        minutes,
    )


@router.get("/wifi/{wifi_id}/metrics", response_model=list[Point])
async def wifi_metrics(wifi_id: int, minutes: int = MinutesQuery):
    await _exists(WifiNetwork, wifi_id, "sieć WiFi")
    return await _series(WifiMetric, WifiMetric.wifi_id, wifi_id, ["clients", "rx_bps", "tx_bps"], minutes)
