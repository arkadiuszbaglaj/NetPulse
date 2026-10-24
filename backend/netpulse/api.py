"""REST API NetPulse (FastAPI).

Wersja wstępna – tylko odczyt, bez logowania. Uwierzytelnianie dojdzie w kroku 4.
Dokumentacja interaktywna: http://<serwer>:8000/docs
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select, text

from . import __version__
from .db import Session, has_timescale, engine
from .db.models import Device, DeviceMetric, Interface, InterfaceMetric, WifiMetric, WifiNetwork

app = FastAPI(title="NetPulse API", version=__version__)


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    host: str
    enabled: bool
    driver: str
    detected_driver: str | None
    snmp_version: str
    kind: str
    vendor: str | None
    model: str | None
    firmware: str | None
    sys_name: str | None
    uptime_s: float | None
    status: str
    last_polled_at: datetime | None
    last_ok_at: datetime | None
    last_error: str | None


class InterfaceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    if_index: int
    name: str
    label: str
    alias: str | None
    role: str
    hidden: bool
    mac: str | None
    admin_up: bool | None
    oper_status: str
    speed_mbps: int | None
    in_bps: float | None = None
    out_bps: float | None = None


class WifiOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    key: str
    ssid: str
    radio: str | None
    channel: int | None
    bssid: str | None
    hidden: bool
    clients: int | None


class Point(BaseModel):
    time: datetime
    values: dict[str, float | None]


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
                select(bucket.label("t"), *[func.avg(c).label(c.key) for c in cols])
                .where(id_col == obj_id, model.time >= since)
                .group_by("t")
                .order_by("t")
            )
        else:
            stmt = (
                select(model.time.label("t"), *cols)
                .where(id_col == obj_id, model.time >= since)
                .order_by(model.time)
            )
        rows = (await session.execute(stmt)).all()
    return [
        Point(time=r.t, values={c: (float(v) if v is not None else None) for c, v in zip(columns, r[1:], strict=True)})
        for r in rows
    ]


@app.get("/api/health")
async def health() -> dict:
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
        timescale = await has_timescale(conn)
    return {"status": "ok", "version": __version__, "timescaledb": timescale}


@app.get("/api/devices", response_model=list[DeviceOut])
async def list_devices():
    async with Session() as session:
        return (await session.scalars(select(Device).order_by(Device.id))).all()


@app.get("/api/devices/{device_id}", response_model=DeviceOut)
async def get_device(device_id: int):
    async with Session() as session:
        device = await session.get(Device, device_id)
        if not device:
            raise HTTPException(404, "Nie ma takiego urządzenia")
        return device


@app.get("/api/devices/{device_id}/interfaces", response_model=list[InterfaceOut])
async def device_interfaces(device_id: int, include_hidden: bool = False):
    async with Session() as session:
        stmt = select(Interface).where(Interface.device_id == device_id).order_by(Interface.if_index)
        if not include_hidden:
            stmt = stmt.where(Interface.hidden.is_(False))
        interfaces = (await session.scalars(stmt)).all()
        if not interfaces:
            return []
        # Ostatnia próbka dla każdego interfejsu (z ostatnich 5 minut)
        since = datetime.now(UTC) - timedelta(minutes=5)
        latest = (
            select(InterfaceMetric.interface_id, InterfaceMetric.in_bps, InterfaceMetric.out_bps)
            .distinct(InterfaceMetric.interface_id)
            .where(
                InterfaceMetric.interface_id.in_([i.id for i in interfaces]),
                InterfaceMetric.time >= since,
            )
            .order_by(InterfaceMetric.interface_id, InterfaceMetric.time.desc())
        )
        last = {r.interface_id: r for r in await session.execute(latest)}
    out = []
    for i in interfaces:
        item = InterfaceOut.model_validate(i)
        if i.id in last:
            item.in_bps, item.out_bps = last[i.id].in_bps, last[i.id].out_bps
        out.append(item)
    return out


@app.get("/api/devices/{device_id}/wifi", response_model=list[WifiOut])
async def device_wifi(device_id: int, include_hidden: bool = False):
    async with Session() as session:
        stmt = select(WifiNetwork).where(WifiNetwork.device_id == device_id).order_by(WifiNetwork.key)
        if not include_hidden:
            stmt = stmt.where(WifiNetwork.hidden.is_(False))
        return (await session.scalars(stmt)).all()


@app.get("/api/devices/{device_id}/metrics", response_model=list[Point])
async def device_metrics(device_id: int, minutes: int = Query(60, ge=5, le=60 * 24 * 30)):
    return await _series(
        DeviceMetric,
        DeviceMetric.device_id,
        device_id,
        ["cpu_percent", "mem_used_percent", "load1", "poll_ms"],
        minutes,
    )


@app.get("/api/interfaces/{interface_id}/metrics", response_model=list[Point])
async def interface_metrics(interface_id: int, minutes: int = Query(60, ge=5, le=60 * 24 * 30)):
    return await _series(
        InterfaceMetric,
        InterfaceMetric.interface_id,
        interface_id,
        ["in_bps", "out_bps", "in_errors", "out_errors", "in_discards", "out_discards"],
        minutes,
    )


@app.get("/api/wifi/{wifi_id}/metrics", response_model=list[Point])
async def wifi_metrics(wifi_id: int, minutes: int = Query(60, ge=5, le=60 * 24 * 30)):
    return await _series(
        WifiMetric, WifiMetric.wifi_id, wifi_id, ["clients", "rx_bps", "tx_bps"], minutes
    )
