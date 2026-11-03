"""Zdarzenia na osi czasu wykresów (adnotacje): restarty urządzeń i przełączenia WAN.

Alertów na wykresach nie ma (od 0.48.0) – są na liście alertów i pod dzwonkiem.

- GET /api/events?minutes=&offset= – zdarzenia w oknie wykresu (to samo okno co metryki), najnowsze na końcu.

Restart = spadek `uptime_s` między kolejnymi próbkami urządzenia; czas restartu to chwila próbki minus nowy
uptime. Restarty i przełączenia WAN liczymy z surowych próbek, więc tylko do `DETAIL_MAX_MINUTES` wstecz –
dla roku byłyby to miliony wierszy.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, text

from .. import wan_links
from ..db import Session
from ..db.models import Device, WanLink
from ..modules import hidden_drivers, read_modules
from ..wan import switches
from .metrics import MinutesQuery, OffsetQuery, window
from .security import require_user
from .wan import _samples

router = APIRouter(prefix="/api", tags=["zdarzenia"], dependencies=[Depends(require_user)])

DETAIL_MAX_MINUTES = 31 * 24 * 60
MAX_EVENTS = 300

EventKind = Literal["restart", "wan_switch"]


class EventOut(BaseModel):
    time: datetime
    kind: EventKind
    title: str
    device_id: int | None = None


_RESTARTS_SQL = text(
    """
    SELECT device_id, time, uptime_s FROM (
        SELECT device_id, time, uptime_s,
               LAG(uptime_s) OVER (PARTITION BY device_id ORDER BY time) AS prev
        FROM device_metrics
        WHERE device_id = ANY(:ids) AND uptime_s IS NOT NULL AND time >= :before AND time < :until
    ) s
    WHERE prev IS NOT NULL AND uptime_s < prev AND time >= :since
    """
)


def _names(ids, names: dict[int, str]) -> str:
    return " + ".join(names.get(i, f"#{i}") for i in ids)


@router.get("/events", response_model=list[EventOut])
async def events(minutes: int = MinutesQuery, offset: int = OffsetQuery) -> list[EventOut]:
    since, until = window(minutes, offset)
    out: list[EventOut] = []
    async with Session() as session:
        hidden = hidden_drivers(await read_modules(session))
        devices = {
            d.id: d.name
            for d in (await session.scalars(select(Device).where(Device.driver.not_in(hidden or ("",))))).all()
        }

        if minutes <= DETAIL_MAX_MINUTES and devices:
            rows = await session.execute(
                _RESTARTS_SQL, {"ids": list(devices), "before": since - timedelta(hours=1), "since": since, "until": until}
            )
            for device_id, t, uptime in rows:
                at = max(since, t - timedelta(seconds=float(uptime)))
                out.append(EventOut(time=at, kind="restart", title=devices[device_id], device_id=device_id))

            links = (await session.scalars(select(WanLink).where(WanLink.device_id.in_(list(devices))))).all()
            if links:
                names = {x.id: x.name for x in links}
                samples = await _samples(session, list(names), since)
                owner = {x.id: x.device_id for x in links}
                gap = wan_links.stale_after()
                # Kolejność łączy jest wspólna dla routerów – ruch może przejść z routera na router
                for sw in switches({x.id: [s for s in samples.get(x.id, []) if s.time < until] for x in links}, gap):
                    title = f"{_names(sw.from_ids, names)} → {_names(sw.to_ids, names)}"
                    out.append(EventOut(time=sw.time, kind="wan_switch", title=title, device_id=owner[sw.to_ids[0]]))

    out.sort(key=lambda e: e.time)
    return out[-MAX_EVENTS:]
