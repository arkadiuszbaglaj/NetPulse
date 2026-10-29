"""Zdarzenia na osi czasu wykresów (adnotacje): alerty (początek i koniec), restarty urządzeń, przełączenia WAN.

- GET /api/events?minutes=&offset= – zdarzenia w oknie wykresu (to samo okno co metryki), najnowsze na końcu.

Restart = spadek `uptime_s` między kolejnymi próbkami urządzenia; czas restartu to chwila próbki minus nowy
uptime. Restarty i przełączenia WAN liczymy z surowych próbek, więc tylko do `DETAIL_MAX_MINUTES` wstecz –
dla roku byłyby to miliony wierszy; alerty są w każdym zakresie.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, or_, select, text

from ..db import Session
from ..db.models import Alert, Device, WanLink
from ..modules import hidden_drivers, read_modules
from ..wan import switches
from .metrics import MinutesQuery, OffsetQuery, window
from .security import require_user
from .wan import _samples

router = APIRouter(prefix="/api", tags=["zdarzenia"], dependencies=[Depends(require_user)])

DETAIL_MAX_MINUTES = 31 * 24 * 60
MAX_EVENTS = 300

EventKind = Literal["alert", "alert_end", "restart", "wan_switch"]


class EventOut(BaseModel):
    time: datetime
    kind: EventKind
    # Alert: info | warning | critical; pozostałe – None
    severity: str | None = None
    title: str
    device_id: int | None = None
    # Alert o porcie (podmiot „i15”) – wykres portu pokazuje tylko swoje
    interface_id: int | None = None


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


def _interface_id(subject: str) -> int | None:
    return int(subject[1:]) if subject.startswith("i") and subject[1:].isdigit() else None


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

        alerts = (
            await session.scalars(
                select(Alert).where(
                    or_(
                        and_(Alert.started_at >= since, Alert.started_at < until),
                        and_(Alert.resolved_at >= since, Alert.resolved_at < until),
                    )
                )
            )
        ).all()
        for a in alerts:
            if a.device_id is not None and a.device_id not in devices:
                continue  # urządzenie wyłączonego modułu
            base = {"severity": a.severity, "device_id": a.device_id, "interface_id": _interface_id(a.subject)}
            if since <= a.started_at < until:
                out.append(EventOut(time=a.started_at, kind="alert", title=a.title, **base))
            if a.resolved_at is not None and since <= a.resolved_at < until:
                out.append(EventOut(time=a.resolved_at, kind="alert_end", title=a.title, **base))

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
                by_device: dict[int, dict] = defaultdict(dict)
                for x in links:
                    by_device[x.device_id][x.id] = [s for s in samples.get(x.id, []) if s.time < until]
                for device_id, group in by_device.items():
                    for sw in switches(group):
                        title = f"{_names(sw.from_ids, names)} → {_names(sw.to_ids, names)}"
                        out.append(EventOut(time=sw.time, kind="wan_switch", title=title, device_id=device_id))

    out.sort(key=lambda e: e.time)
    return out[-MAX_EVENTS:]
