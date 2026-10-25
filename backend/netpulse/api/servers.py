"""Serwery Linux monitorowane przez SNMP: bieżący stan (CPU, RAM, swap, dyski) jednym zapytaniem."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from ..db import Session
from ..db.models import Device, DeviceMetric, DiskMetric, ServerMetric
from .security import require_user

router = APIRouter(prefix="/api", tags=["serwery"], dependencies=[Depends(require_user)])

CURRENT_WINDOW = timedelta(minutes=5)


class DiskOut(BaseModel):
    mount: str
    total_bytes: int
    used_bytes: int
    used_percent: float


class ServerOut(BaseModel):
    sampled_at: datetime
    cpu_percent: float | None
    mem_used_percent: float | None
    swap_used_percent: float | None
    load1: float | None
    uptime_s: float | None
    processes: int | None
    disks: list[DiskOut]


@router.get("/devices/{device_id}/server", response_model=ServerOut | None)
async def device_server(device_id: int):
    """Ostatnia próbka serwera albo null, gdy urządzenie nie odpowiada od ponad 5 minut (albo nie jest serwerem)."""
    since = datetime.now(UTC) - CURRENT_WINDOW
    async with Session() as session:
        if await session.get(Device, device_id) is None:
            raise HTTPException(404, "Nie ma takiego urządzenia")
        health = await session.scalar(
            select(DeviceMetric)
            .where(DeviceMetric.device_id == device_id, DeviceMetric.reachable.is_(True), DeviceMetric.time >= since)
            .order_by(DeviceMetric.time.desc())
            .limit(1)
        )
        if health is None:
            return None
        extra = await session.scalar(
            select(ServerMetric).where(ServerMetric.device_id == device_id).order_by(ServerMetric.time.desc()).limit(1)
        )
        disk_rows = (
            await session.scalars(
                select(DiskMetric)
                .where(DiskMetric.device_id == device_id, DiskMetric.time >= since)
                .distinct(DiskMetric.mount)
                .order_by(DiskMetric.mount, DiskMetric.time.desc())
            )
        ).all()
    return ServerOut(
        sampled_at=health.time,
        cpu_percent=health.cpu_percent,
        mem_used_percent=health.mem_used_percent,
        swap_used_percent=extra.swap_used_percent if extra and extra.time >= since else None,
        load1=health.load1,
        uptime_s=health.uptime_s,
        processes=extra.processes if extra and extra.time >= since else None,
        disks=[
            DiskOut(
                mount=d.mount,
                total_bytes=d.total_bytes,
                used_bytes=d.used_bytes,
                used_percent=round(100.0 * d.used_bytes / d.total_bytes, 1) if d.total_bytes else 0.0,
            )
            for d in disk_rows
        ],
    )
