"""Szczegóły klienta sieci: stan teraz, historia sygnału i prędkości, obecność w sieci i przejścia między AP.

Dane z kolektora UniFi (`known_clients`, `client_metrics`); bieżący stan z `network_clients`."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel
from sqlalchemy import func, select, text

from ..config import settings
from ..db import Session
from ..db.models import ClientMetric, KnownClient, NetworkClient
from .controllers import ClientOut
from .metrics import MinutesQuery, _bucket_seconds, _series
from .schemas import Point
from .security import require_user

router = APIRouter(prefix="/api/clients", tags=["UniFi"], dependencies=[Depends(require_user)])

MacPath = Path(pattern=r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$", description="adres MAC klienta, np. 02:00:00:00:00:01")
# Przerwa dłuższa niż tyle cykli kolektora = klient był rozłączony
GAP_CYCLES = 3
MAX_EVENTS = 100


class ClientDetailOut(BaseModel):
    mac: str
    name: str | None
    ip: str | None
    is_wired: bool
    is_guest: bool
    online: bool
    first_seen_at: datetime
    last_seen_at: datetime
    # Stan z ostatniego odczytu kontrolera; None, gdy klienta teraz nie ma w sieci
    current: ClientOut | None


class PresenceBucket(BaseModel):
    time: datetime
    samples: int


class PresenceOut(BaseModel):
    interval_s: int
    # Ile próbek w kubełku oznacza obecność przez cały kubełek (interwał / co ile kolektor zapisuje stan)
    expected: float
    buckets: list[PresenceBucket]


class ClientEvent(BaseModel):
    time: datetime
    kind: str  # connect – pojawił się (pierwszy raz albo po przerwie) | roam – inny AP/switch | band – inne pasmo
    uplink_device_id: int | None
    uplink_name: str | None
    uplink_port: int | None
    essid: str | None
    radio: str | None
    gap_s: int | None = None  # dla connect po przerwie: jak długo klienta nie było


async def _known(session, mac: str) -> KnownClient:
    known = await session.get(KnownClient, mac)
    if known is None:
        raise HTTPException(404, "Nie ma takiego klienta – kontroler go jeszcze nie widział")
    return known


@router.get("/{mac}", response_model=ClientDetailOut)
async def client_detail(mac: str = MacPath):
    mac = mac.lower()
    async with Session() as session:
        known = await _known(session, mac)
        current = await session.scalar(
            select(NetworkClient).where(NetworkClient.mac == mac).order_by(NetworkClient.updated_at.desc()).limit(1)
        )
    return ClientDetailOut(
        mac=known.mac,
        name=(current.name if current else None) or known.name,
        ip=(current.ip if current else None) or known.ip,
        is_wired=current.is_wired if current else known.is_wired,
        is_guest=current.is_guest if current else known.is_guest,
        online=current is not None,
        first_seen_at=known.first_seen_at,
        last_seen_at=known.last_seen_at,
        current=ClientOut.model_validate(current) if current else None,
    )


@router.get("/{mac}/metrics", response_model=list[Point])
async def client_metrics(mac: str = MacPath, minutes: int = MinutesQuery):
    """Sygnał (dBm) i prędkość łącza (kb/s) w czasie; dla klienta po kablu prędkości zwykle brak."""
    mac = mac.lower()
    async with Session() as session:
        await _known(session, mac)
    return await _series(ClientMetric, ClientMetric.mac, mac, ["signal_dbm", "rx_rate_kbps", "tx_rate_kbps"], minutes)


@router.get("/{mac}/presence", response_model=PresenceOut)
async def client_presence(mac: str = MacPath, minutes: int = MinutesQuery):
    """Obecność w sieci: liczba próbek w kubełkach (kubełek bez próbek = klienta nie było)."""
    mac = mac.lower()
    stride = _bucket_seconds(minutes)
    since = datetime.now(UTC) - timedelta(minutes=minutes)
    bucket = func.date_bin(text(f"INTERVAL '{stride} seconds'"), ClientMetric.time, text("TIMESTAMPTZ '2000-01-01 00:00:00+00'")).label("b")
    async with Session() as session:
        await _known(session, mac)
        rows = (
            await session.execute(
                select(bucket, func.count()).where(ClientMetric.mac == mac, ClientMetric.time >= since).group_by("b").order_by("b")
            )
        ).all()
    return PresenceOut(
        interval_s=stride,
        expected=stride / settings.poll_interval,
        buckets=[PresenceBucket(time=t, samples=n) for t, n in rows],
    )


_EVENTS_SQL = text(
    """
    SELECT time, uplink_device_id, uplink_name, uplink_port, essid, radio, prev_time, prev_uplink, prev_radio FROM (
        SELECT time, uplink_device_id, uplink_name, uplink_port, essid, radio,
               lag(time) OVER w AS prev_time, lag(uplink_device_id) OVER w AS prev_uplink, lag(radio) OVER w AS prev_radio
        FROM client_metrics WHERE mac = :mac AND time >= :since
        WINDOW w AS (ORDER BY time)
    ) x
    WHERE prev_time IS NULL OR time - prev_time > :gap
       OR uplink_device_id IS DISTINCT FROM prev_uplink OR radio IS DISTINCT FROM prev_radio
    ORDER BY time DESC LIMIT :limit
    """
)


@router.get("/{mac}/events", response_model=list[ClientEvent])
async def client_events(mac: str = MacPath, minutes: int = MinutesQuery):
    """Historia połączeń od najnowszych: pojawienie się w sieci, przejście na inny AP, zmiana pasma."""
    mac = mac.lower()
    since = datetime.now(UTC) - timedelta(minutes=minutes)
    gap = timedelta(seconds=settings.poll_interval * GAP_CYCLES)
    async with Session() as session:
        await _known(session, mac)
        rows = (await session.execute(_EVENTS_SQL, {"mac": mac, "since": since, "gap": gap, "limit": MAX_EVENTS})).all()
    events = []
    for r in rows:
        if r.prev_time is None or r.time - r.prev_time > gap:
            kind, gap_s = "connect", int((r.time - r.prev_time).total_seconds()) if r.prev_time else None
        elif r.uplink_device_id != r.prev_uplink:
            kind, gap_s = "roam", None
        else:
            kind, gap_s = "band", None
        events.append(
            ClientEvent(
                time=r.time,
                kind=kind,
                uplink_device_id=r.uplink_device_id,
                uplink_name=r.uplink_name,
                uplink_port=r.uplink_port,
                essid=r.essid,
                radio=r.radio,
                gap_s=gap_s,
            )
        )
    return events
