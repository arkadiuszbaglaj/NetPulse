"""Szeregi czasowe metryk do wykresów."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, text

from ..db import Session, engine, has_timescale
from ..db.models import (
    Device,
    DeviceMetric,
    Interface,
    InterfaceMetric,
    Metric,
    ProxmoxNode,
    WifiMetric,
    WifiNetwork,
)
from .schemas import Point
from .security import require_user

router = APIRouter(prefix="/api", tags=["metryki"], dependencies=[Depends(require_user)])

MinutesQuery = Query(60, ge=5, le=60 * 24 * 30, description="zakres wstecz w minutach")


def _bucket_seconds(minutes: int) -> int:
    """Rozmiar kubełka tak, żeby wykres miał ~300 punktów, nie mniej niż 30 s."""
    return max(30, (minutes * 60) // 300)


async def _series(model, id_col, obj_id: int | None, columns: list[str], minutes: int) -> list[Point]:
    """Szereg czasowy; `id_col=None` dla tabel bez klucza obiektu (np. stan serwera)."""
    since = datetime.now(UTC) - timedelta(minutes=minutes)
    async with Session() as session:
        async with engine.connect() as conn:
            timescale = await has_timescale(conn)
        cols = [getattr(model, c) for c in columns]
        where = [model.time >= since] + ([id_col == obj_id] if id_col is not None else [])
        if timescale:
            bucket = func.time_bucket(text(f"INTERVAL '{_bucket_seconds(minutes)} seconds'"), model.time)
            stmt = (
                select(bucket.label("bucket"), *[func.avg(c).label(c.key) for c in cols])
                .where(*where)
                .group_by("bucket")
                .order_by("bucket")
            )
        else:
            stmt = (
                select(model.time.label("bucket"), *cols)
                .where(*where)
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


# Źródło wykresu z agenta → {klucz serii: (nazwa w `metrics`, mnożnik)}. Dyski: bajty/s → bity/s, jak reszta przepustowości.
AGENT_SOURCES: dict[str, dict[str, tuple[str, float]]] = {
    "agent_net": {"rx_bps": ("net_rx_bps", 1.0), "tx_bps": ("net_tx_bps", 1.0)},
    "agent_disk": {"read_bps": ("disk_read_bps", 8.0), "write_bps": ("disk_write_bps", 8.0)},
    "agent_temp": {"temp_c": ("temp_c", 1.0)},
    "agent_container": {"container_cpu_percent": ("container_cpu_percent", 1.0), "container_mem_bytes": ("container_mem_bytes", 1.0)},
    # Maszyna Proxmox: kolektor zapisuje już bity/s (sieć) i bajty/s (dysk) – dysk przeliczamy na bity jak przy agencie
    "pve_guest": {
        "guest_cpu_percent": ("guest_cpu_percent", 1.0),
        "guest_mem_bytes": ("guest_mem_bytes", 1.0),
        "rx_bps": ("guest_net_rx_bps", 1.0),
        "tx_bps": ("guest_net_tx_bps", 1.0),
        "read_bps": ("guest_disk_read_bps", 8.0),
        "write_bps": ("guest_disk_write_bps", 8.0),
    },
}
AgentSourceKind = Literal["agent_cpu", "agent_net", "agent_disk", "agent_temp", "agent_container", "pve_guest"]
# Lista kluczy do edytora wykresu: źródło → nazwa metryki, z której bierzemy klucze
AGENT_KEY_NAMES = {
    "agent_net": "net_rx_bps",
    "agent_disk": "disk_read_bps",
    "agent_temp": "temp_c",
    "agent_container": "container_up",
    "pve_guest": "guest_up",
}


async def _same_server_devices(session, device_id: int) -> list[int]:
    """Maszyna Proxmox może przejść na inny węzeł (migracja) – wykres bierze dane ze wszystkich węzłów serwera."""
    server_id = await session.scalar(select(ProxmoxNode.server_id).where(ProxmoxNode.device_id == device_id))
    if server_id is None:
        return [device_id]
    return list((await session.scalars(select(ProxmoxNode.device_id).where(ProxmoxNode.server_id == server_id))).all())


def _bucket(minutes: int, timescale: bool):
    if timescale:
        return func.time_bucket(text(f"INTERVAL '{_bucket_seconds(minutes)} seconds'"), Metric.time)
    return Metric.time


@router.get("/devices/{device_id}/agent-metrics", response_model=list[Point])
async def agent_metrics(device_id: int, source: AgentSourceKind, key: str = "", minutes: int = MinutesQuery):
    """Szereg z ogólnej tabeli `metrics` dla wykresu. `agent_cpu`: najbardziej i średnio obciążony rdzeń."""
    await _exists(Device, device_id, "urządzenie")
    since = datetime.now(UTC) - timedelta(minutes=minutes)
    async with engine.connect() as conn:
        timescale = await has_timescale(conn)
    bucket = _bucket(minutes, timescale).label("bucket")
    async with Session() as session:
        devices = await _same_server_devices(session, device_id) if source == "pve_guest" else [device_id]
        base = [Metric.device_id.in_(devices), Metric.time >= since]
        if source == "agent_cpu":
            rows = (
                await session.execute(
                    select(bucket, func.max(Metric.value), func.avg(Metric.value))
                    .where(*base, Metric.name == "cpu_core_percent")
                    .group_by("bucket")
                    .order_by("bucket")
                )
            ).all()
            return [Point(time=t, values={"core_max_percent": mx, "core_avg_percent": avg}) for t, mx, avg in rows]
        series = AGENT_SOURCES[source]
        by_name = {name: (series_key, factor) for series_key, (name, factor) in series.items()}
        rows = (
            await session.execute(
                select(bucket, Metric.name, func.avg(Metric.value))
                .where(*base, Metric.name.in_(list(by_name)), Metric.key == key)
                .group_by("bucket", Metric.name)
                .order_by("bucket")
            )
        ).all()
    points: dict[datetime, dict[str, float | None]] = {}
    for t, name, value in rows:
        series_key, factor = by_name[name]
        points.setdefault(t, dict.fromkeys(series))[series_key] = float(value) * factor if value is not None else None
    return [Point(time=t, values=v) for t, v in points.items()]


@router.get("/devices/{device_id}/agent-keys")
async def agent_keys(device_id: int) -> dict[str, list[str]]:
    """Interfejsy, dyski, czujniki i kontenery widziane w ostatniej godzinie – do wyboru w edytorze wykresu."""
    await _exists(Device, device_id, "urządzenie")
    since = datetime.now(UTC) - timedelta(hours=1)
    async with Session() as session:
        rows = (
            await session.execute(
                select(Metric.name, Metric.key)
                .where(Metric.device_id.in_(await _same_server_devices(session, device_id)), Metric.time >= since, Metric.name.in_(list(AGENT_KEY_NAMES.values())))
                .distinct()
                .order_by(Metric.name, Metric.key)
            )
        ).all()
        rows = list(dict.fromkeys(rows))
    out: dict[str, list[str]] = {source: [] for source in AGENT_KEY_NAMES}
    by_name = {name: source for source, name in AGENT_KEY_NAMES.items()}
    for name, key in rows:
        out[by_name[name]].append(key)
    return out


@router.get("/wifi/{wifi_id}/metrics", response_model=list[Point])
async def wifi_metrics(wifi_id: int, minutes: int = MinutesQuery):
    await _exists(WifiNetwork, wifi_id, "sieć WiFi")
    return await _series(WifiMetric, WifiMetric.wifi_id, wifi_id, ["clients", "rx_bps", "tx_bps"], minutes)
