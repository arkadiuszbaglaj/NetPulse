"""Zdarzenia: restarty urządzeń, przełączenia WAN i nowe połączenia VPN – kafelek „Zdarzenia” na pulpicie (na wykresach nie są rysowane).

- GET /api/events?minutes=&offset= – zdarzenia z okna (to samo okno co metryki), najnowsze na końcu.

Liczone z surowych próbek (netpulse/timeline.py), więc tylko do `DETAIL_MAX_MINUTES` wstecz – dla roku byłyby to
miliony wierszy. Alerty (także „Restart urządzenia” i „Przełączenie WAN”) są na liście alertów i pod dzwonkiem.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from .. import vpn
from ..db import Session
from ..db.models import Device
from ..modules import hidden_drivers, read_modules
from ..timeline import restarts, wan_switches
from .metrics import MinutesQuery, OffsetQuery, window
from .security import require_user

router = APIRouter(prefix="/api", tags=["zdarzenia"], dependencies=[Depends(require_user)])

DETAIL_MAX_MINUTES = 31 * 24 * 60
MAX_EVENTS = 300

EventKind = Literal["restart", "wan_switch", "vpn_connect"]


class EventOut(BaseModel):
    time: datetime
    kind: EventKind
    title: str
    device_id: int | None = None


@router.get("/events", response_model=list[EventOut])
async def events(minutes: int = MinutesQuery, offset: int = OffsetQuery) -> list[EventOut]:
    since, until = window(minutes, offset)
    out: list[EventOut] = []
    async with Session() as session:
        modules = await read_modules(session)
        hidden = hidden_drivers(modules)
        devices = {
            d.id: d.name
            for d in (await session.scalars(select(Device).where(Device.driver.not_in(hidden or ("",))))).all()
        }
        if minutes <= DETAIL_MAX_MINUTES and devices:
            for r in await restarts(session, devices, since, until):
                out.append(EventOut(time=r.time, kind="restart", title=devices[r.device_id], device_id=r.device_id))
            for sw in await wan_switches(session, devices, since, until):
                out.append(EventOut(time=sw.time, kind="wan_switch", title=f"{sw.from_names} → {sw.to_names}", device_id=sw.device_id))
            if modules.get("unifi", True):
                for c in await vpn.connections(session, devices, since, until):
                    out.append(EventOut(time=c.time, kind="vpn_connect", title=c.user, device_id=c.device_id))
    out.sort(key=lambda e: e.time)
    return out[-MAX_EVENTS:]
